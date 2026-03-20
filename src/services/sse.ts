import type { Response } from 'express';
import { logger } from '../utils/logger';
import { authorizationService } from './authorization';

interface SSEClient {
  id: string;
  userId: string;
  channels: Set<string>;
  res: Response;
  heartbeat?: NodeJS.Timeout;
  lastEventId: number;
}

interface BufferedEvent {
  id: number;
  channel: string;
  event: string;
  data: unknown;
  timestamp: number;
  ttlMs: number;
}

interface EventBufferConfig {
  buffer: boolean;
  ttlMs: number;
}

class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private eventLog: BufferedEvent[] = [];
  private eventIdCounter = 0;
  private readonly MAX_EVENT_LOG_SIZE = 1000;
  private readonly DEFAULT_TTL_MS = 30_000;

  private readonly EVENT_CONFIG: Record<string, EventBufferConfig> = {
    'analysis-status-changed': { buffer: true, ttlMs: 30_000 },
    'analysis-paused': { buffer: true, ttlMs: 30_000 },
    'analysis-progress': { buffer: true, ttlMs: 10_000 },
    'analysis-complete': { buffer: false, ttlMs: 0 },
    'analysis-cancelled': { buffer: false, ttlMs: 0 },
    'analysis-failed': { buffer: false, ttlMs: 0 },

    'job-status-changed': { buffer: true, ttlMs: 30_000 },
    'job-progress': { buffer: true, ttlMs: 10_000 },
    'job-paused': { buffer: true, ttlMs: 30_000 },
    'job-completed': { buffer: true, ttlMs: 5 * 60 * 1000 },
    'job-cancelled': { buffer: false, ttlMs: 0 },
    'job-failed': { buffer: false, ttlMs: 0 },

    'activity-created': { buffer: true, ttlMs: 5 * 60 * 1000 },
    'activity-updated': { buffer: true, ttlMs: 60_000 },

    'nodes-updated': { buffer: false, ttlMs: 0 },
    'update-failed': { buffer: false, ttlMs: 0 },
  };

  private getEventConfig(event: string): EventBufferConfig {
    return (
      this.EVENT_CONFIG[event] ?? { buffer: true, ttlMs: this.DEFAULT_TTL_MS }
    );
  }

  /**
   * Add a unified SSE client with optional initial channels.
   * Used by the new consolidated /sse/events endpoint.
   */
  addUnifiedClient(
    clientId: string,
    userId: string,
    res: Response,
    initialChannels: string[] = [],
    lastEventId?: number,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const client: SSEClient = {
      id: clientId,
      userId,
      channels: new Set(initialChannels),
      res,
      lastEventId: lastEventId ?? this.eventIdCounter,
    };

    const heartbeat = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch {
        logger.debug({ clientId }, 'Heartbeat failed, cleaning up connection');
        clearInterval(heartbeat);
        this.clients.delete(clientId);
      }
    }, 15000);

    client.heartbeat = heartbeat;
    this.clients.set(clientId, client);

    res.write(
      `data: ${JSON.stringify({ type: 'connected', clientId, channels: initialChannels })}\n\n`,
    );

    if (lastEventId !== undefined) {
      this.replayFromEventId(client, lastEventId).catch((err) => {
        logger.error({ err, clientId }, 'Replay failed');
      });
    }

    logger.debug(
      { clientId, channels: initialChannels, totalClients: this.clients.size },
      'Unified SSE client connected',
    );

    res.on('close', () => {
      if (client.heartbeat) clearInterval(client.heartbeat);
      this.clients.delete(clientId);
      logger.debug(
        { clientId, totalClients: this.clients.size },
        'SSE client disconnected',
      );
    });

    res.on('error', (error) => {
      if (client.heartbeat) clearInterval(client.heartbeat);
      logger.error({ error, clientId }, 'SSE client error');
      this.clients.delete(clientId);
    });

    if (res.socket) {
      res.socket.on('error', (error) => {
        if (client.heartbeat) clearInterval(client.heartbeat);
        logger.error({ error, clientId }, 'SSE socket error');
        this.clients.delete(clientId);
      });
    }
  }

  /**
   * Legacy: Add an SSE client subscribed to a single channel.
   * Maintained for backward compatibility during migration.
   */
  addClient(
    clientId: string,
    userId: string,
    channel: string,
    res: Response,
    onDisconnect?: () => void,
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const client: SSEClient = {
      id: clientId,
      userId,
      channels: new Set([channel]),
      res,
      lastEventId: this.eventIdCounter,
    };

    const heartbeat = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch {
        logger.debug({ clientId }, 'Heartbeat failed, cleaning up connection');
        clearInterval(heartbeat);
        this.clients.delete(clientId);
      }
    }, 15000);

    client.heartbeat = heartbeat;
    this.clients.set(clientId, client);

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    this.replayBufferedEventsForChannel(channel, res);

    logger.debug(
      { clientId, channel, totalClients: this.clients.size },
      'SSE client connected',
    );

    res.on('close', () => {
      if (client.heartbeat) clearInterval(client.heartbeat);
      this.clients.delete(clientId);
      onDisconnect?.();
      logger.debug(
        { clientId, totalClients: this.clients.size },
        'SSE client disconnected',
      );
    });

    res.on('error', (error) => {
      if (client.heartbeat) clearInterval(client.heartbeat);
      logger.error({ error, clientId }, 'SSE client error');
      this.clients.delete(clientId);
    });

    if (res.socket) {
      res.socket.on('error', (error) => {
        if (client.heartbeat) clearInterval(client.heartbeat);
        logger.error({ error, clientId }, 'SSE socket error');
        this.clients.delete(clientId);
      });
    }
  }

  /**
   * Add channels to an existing client's subscription.
   */
  addChannels(clientId: string, channels: string[]): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      logger.warn({ clientId }, 'Cannot add channels: client not found');
      return false;
    }

    for (const channel of channels) {
      client.channels.add(channel);
    }

    logger.debug(
      {
        clientId,
        addedChannels: channels,
        totalChannels: client.channels.size,
      },
      'Added channels to SSE client',
    );

    return true;
  }

  /**
   * Remove channels from an existing client's subscription.
   */
  removeChannels(clientId: string, channels: string[]): boolean {
    const client = this.clients.get(clientId);
    if (!client) {
      logger.warn({ clientId }, 'Cannot remove channels: client not found');
      return false;
    }

    for (const channel of channels) {
      client.channels.delete(channel);
    }

    logger.debug(
      {
        clientId,
        removedChannels: channels,
        totalChannels: client.channels.size,
      },
      'Removed channels from SSE client',
    );

    return true;
  }

  /**
   * Get a client's subscribed channels.
   */
  getClientChannels(clientId: string): string[] | null {
    const client = this.clients.get(clientId);
    return client ? Array.from(client.channels) : null;
  }

  /**
   * Check if a client exists.
   */
  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /**
   * Replay events from the event log after a given event ID.
   * Re-validates access for each event to handle permission revocation.
   */
  private async replayFromEventId(
    client: SSEClient,
    fromEventId: number,
  ): Promise<void> {
    const now = Date.now();
    const eventsToReplay = this.eventLog.filter(
      (e) =>
        e.id > fromEventId &&
        client.channels.has(e.channel) &&
        now - e.timestamp < e.ttlMs,
    );

    if (eventsToReplay.length === 0) return;

    logger.debug(
      { clientId: client.id, fromEventId, eventCount: eventsToReplay.length },
      'Replaying missed SSE events',
    );

    for (const evt of eventsToReplay) {
      const result = await authorizationService.validateChannelAccess(
        client.userId,
        evt.channel,
      );
      if (!result.valid) {
        logger.warn(
          { clientId: client.id, channel: evt.channel },
          'Skipping replay - access revoked',
        );
        continue;
      }

      try {
        const message = `id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
        client.res.write(message);
        client.lastEventId = evt.id;
      } catch (error) {
        logger.error(
          { error, clientId: client.id },
          'Failed to replay SSE event',
        );
        break;
      }
    }
  }

  /**
   * Legacy: Replay buffered events for a specific channel (TTL-based).
   */
  private replayBufferedEventsForChannel(channel: string, res: Response): void {
    const now = Date.now();
    const validEvents = this.eventLog.filter(
      (e) => e.channel === channel && now - e.timestamp < e.ttlMs,
    );

    if (validEvents.length === 0) return;

    logger.debug(
      { channel, eventCount: validEvents.length },
      'Replaying buffered SSE events',
    );

    for (const evt of validEvents) {
      try {
        const message = `id: ${evt.id}\nevent: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
        res.write(message);
      } catch (error) {
        logger.error({ error, channel }, 'Failed to replay buffered SSE event');
        break;
      }
    }
  }

  /**
   * Log an event for potential replay.
   */
  private logEvent(
    channel: string,
    event: string,
    data: unknown,
    ttlMs: number,
  ): number {
    const eventId = ++this.eventIdCounter;

    this.eventLog.push({
      id: eventId,
      channel,
      event,
      data,
      timestamp: Date.now(),
      ttlMs,
    });

    // Trim old events
    if (this.eventLog.length > this.MAX_EVENT_LOG_SIZE) {
      this.eventLog = this.eventLog.slice(-this.MAX_EVENT_LOG_SIZE / 2);
    }

    return eventId;
  }

  /**
   * Prune expired events from the log.
   */
  pruneEventLog(): void {
    const now = Date.now();
    const before = this.eventLog.length;
    this.eventLog = this.eventLog.filter((e) => now - e.timestamp < e.ttlMs);
    const pruned = before - this.eventLog.length;
    if (pruned > 0) {
      logger.debug(
        { pruned, remaining: this.eventLog.length },
        'Pruned expired SSE events',
      );
    }
  }

  /**
   * Broadcast an event to all clients subscribed to a channel.
   */
  broadcast(channel: string, event: string, data: unknown): void {
    const config = this.getEventConfig(event);
    let eventId: number | undefined;

    if (config.buffer) {
      eventId = this.logEvent(channel, event, data, config.ttlMs);
    } else {
      eventId = ++this.eventIdCounter;
    }

    const message = `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const channelClients = Array.from(this.clients.values()).filter((c) =>
      c.channels.has(channel),
    );

    if (channelClients.length === 0) {
      logger.debug(
        { event, channel },
        'SSE event logged but no active subscribers',
      );
      return;
    }

    logger.debug(
      { event, channel, clientCount: channelClients.length },
      'Broadcasting SSE event',
    );

    let successCount = 0;
    for (const client of channelClients) {
      try {
        client.res.write(message);
        client.lastEventId = eventId;
        successCount++;
      } catch (error) {
        logger.error(
          { error, clientId: client.id },
          'Failed to send SSE message',
        );
        this.clients.delete(client.id);
      }
    }

    if (successCount > 0) {
      logger.debug({ event, successCount }, 'SSE event sent');
    }
  }

  /**
   * Broadcast to all connected clients (regardless of channel).
   */
  broadcastAll(event: string, data: unknown): void {
    const eventId = ++this.eventIdCounter;
    const message = `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients.values()) {
      try {
        client.res.write(message);
        client.lastEventId = eventId;
      } catch (error) {
        logger.error(
          { error, clientId: client.id },
          'Failed to send SSE message',
        );
        this.clients.delete(client.id);
      }
    }
  }

  broadcastToDocument(documentId: string, event: string, data: unknown): void {
    this.broadcast(`document:${documentId}`, event, data);
  }

  broadcastToNode(nodeId: string, event: string, data: unknown): void {
    this.broadcast(`node:${nodeId}`, event, data);
  }

  broadcastToUser(userId: string, event: string, data: unknown): void {
    this.broadcast(`user:${userId}`, event, data);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getCurrentEventId(): number {
    return this.eventIdCounter;
  }

  /**
   * Clear events from log for a specific channel.
   */
  clearBuffer(channel: string): void {
    this.eventLog = this.eventLog.filter((e) => e.channel !== channel);
  }

  clearDocumentBuffer(documentId: string): void {
    this.clearBuffer(`document:${documentId}`);
  }

  /**
   * Force-close all SSE connections during shutdown.
   */
  closeAll(): void {
    if (this.clients.size === 0) return;

    logger.info(
      { clientCount: this.clients.size },
      'Closing all SSE connections',
    );

    for (const client of this.clients.values()) {
      try {
        client.res.write(
          `event: shutdown\ndata: ${JSON.stringify({ reason: 'server_shutdown' })}\n\n`,
        );
        client.res.end();
      } catch {
        // Connection may already be closed
      }
    }

    this.clients.clear();
    this.eventLog = [];
  }
}

export const sseService = new SSEService();
