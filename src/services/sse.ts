import type { Response } from 'express';
import { logger } from '../utils/logger';

interface SSEClient {
  id: string;
  channel: string;
  res: Response;
  heartbeat?: NodeJS.Timeout;
}

interface BufferedEvent {
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
  private eventBuffer: Map<string, BufferedEvent[]> = new Map();
  private readonly BUFFER_SIZE = 10;
  private readonly DEFAULT_TTL_MS = 30_000; // 30 seconds default

  // Per-event buffer configuration
  private readonly EVENT_CONFIG: Record<string, EventBufferConfig> = {
    // Legacy analysis events (backwards compatibility)
    'analysis-status-changed': { buffer: true, ttlMs: 30_000 },
    'analysis-paused': { buffer: true, ttlMs: 30_000 },
    'analysis-progress': { buffer: true, ttlMs: 10_000 },
    'analysis-complete': { buffer: false, ttlMs: 0 },
    'analysis-cancelled': { buffer: false, ttlMs: 0 },
    'analysis-failed': { buffer: false, ttlMs: 0 },

    // New job-based events
    'job-status-changed': { buffer: true, ttlMs: 30_000 },
    'job-progress': { buffer: true, ttlMs: 10_000 },
    'job-paused': { buffer: true, ttlMs: 30_000 },
    'job-completed': { buffer: false, ttlMs: 0 },
    'job-cancelled': { buffer: false, ttlMs: 0 },
    'job-failed': { buffer: false, ttlMs: 0 },

    // Other events
    'nodes-updated': { buffer: false, ttlMs: 0 },
    'update-failed': { buffer: false, ttlMs: 0 },
  };

  private getEventConfig(event: string): EventBufferConfig {
    return (
      this.EVENT_CONFIG[event] ?? { buffer: true, ttlMs: this.DEFAULT_TTL_MS }
    );
  }

  /**
   * Add an SSE client subscribed to a channel
   * Channel format is caller-defined, e.g., "document:abc123", "node:xyz789"
   */
  addClient(
    clientId: string,
    channel: string,
    res: Response,
    onDisconnect?: () => void,
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders();

    const client: SSEClient = { id: clientId, channel, res };

    // Send heartbeat every 15 seconds to prevent proxy/network timeouts
    const heartbeat = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch (_err) {
        logger.debug({ clientId }, 'Heartbeat failed, cleaning up connection');
        clearInterval(heartbeat);
        this.clients.delete(clientId);
      }
    }, 15000);

    client.heartbeat = heartbeat;
    this.clients.set(clientId, client);

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Replay buffered events for this channel
    this.replayBufferedEvents(channel, res);

    logger.debug(
      { clientId, channel, totalClients: this.clients.size },
      'SSE client connected',
    );

    res.on('close', () => {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
      }
      this.clients.delete(clientId);
      onDisconnect?.();
      logger.debug(
        { clientId, totalClients: this.clients.size },
        'SSE client disconnected',
      );
    });

    res.on('error', (error) => {
      if (client.heartbeat) {
        clearInterval(client.heartbeat);
      }
      logger.error({ error, clientId }, 'SSE client error');
      this.clients.delete(clientId);
    });

    if (res.socket) {
      res.socket.on('error', (error) => {
        if (client.heartbeat) {
          clearInterval(client.heartbeat);
        }
        logger.error({ error, clientId }, 'SSE socket error');
        this.clients.delete(clientId);
      });
    }
  }

  /**
   * Replay buffered events to a newly connected client
   */
  private replayBufferedEvents(channel: string, res: Response) {
    const buffer = this.eventBuffer.get(channel);
    if (!buffer || buffer.length === 0) return;

    const now = Date.now();
    const validEvents = buffer.filter((e) => now - e.timestamp < e.ttlMs);

    if (validEvents.length === 0) {
      this.eventBuffer.delete(channel);
      return;
    }

    logger.debug(
      { channel, eventCount: validEvents.length },
      'Replaying buffered SSE events',
    );

    for (const bufferedEvent of validEvents) {
      try {
        const message = `event: ${bufferedEvent.event}\ndata: ${JSON.stringify(bufferedEvent.data)}\n\n`;
        res.write(message);
      } catch (error) {
        logger.error({ error, channel }, 'Failed to replay buffered SSE event');
        break;
      }
    }
  }

  /**
   * Buffer an event for later replay to new clients
   */
  private bufferEvent(
    channel: string,
    event: string,
    data: unknown,
    ttlMs: number,
  ) {
    if (!this.eventBuffer.has(channel)) {
      this.eventBuffer.set(channel, []);
    }

    const buffer = this.eventBuffer.get(channel);
    if (!buffer) return;
    buffer.push({ event, data, timestamp: Date.now(), ttlMs });

    // Trim to buffer size
    if (buffer.length > this.BUFFER_SIZE) {
      buffer.shift();
    }
  }

  /**
   * Broadcast an event to all clients subscribed to a channel
   */
  broadcast(channel: string, event: string, data: unknown) {
    const config = this.getEventConfig(event);

    if (config.buffer) {
      this.bufferEvent(channel, event, data, config.ttlMs);
    }

    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const channelClients = Array.from(this.clients.values()).filter(
      (c) => c.channel === channel,
    );

    if (channelClients.length === 0) {
      logger.warn(
        { event, channel },
        'SSE event buffered but no active subscribers',
      );
      return;
    }

    logger.debug(
      { event, channel, clientCount: channelClients.length },
      'Broadcasting SSE event',
    );

    let successCount = 0;
    for (const [clientId, client] of this.clients) {
      if (client.channel === channel) {
        try {
          client.res.write(message);
          successCount++;
        } catch (error) {
          logger.error({ error, clientId }, 'Failed to send SSE message');
          this.clients.delete(clientId);
        }
      }
    }

    if (successCount > 0) {
      logger.debug({ event, successCount }, 'SSE event sent');
    }
  }

  /**
   * Broadcast to all connected clients (regardless of channel)
   */
  broadcastAll(event: string, data: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const [clientId, client] of this.clients) {
      try {
        client.res.write(message);
      } catch (error) {
        logger.error({ error, clientId }, 'Failed to send SSE message');
        this.clients.delete(clientId);
      }
    }
  }

  // Convenience wrappers for common channel types
  broadcastToDocument(documentId: string, event: string, data: any) {
    this.broadcast(`document:${documentId}`, event, data);
  }

  broadcastToNode(nodeId: string, event: string, data: any) {
    this.broadcast(`node:${nodeId}`, event, data);
  }

  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Clear event buffer for a channel (e.g., when analysis completes)
   */
  clearBuffer(channel: string): void {
    this.eventBuffer.delete(channel);
  }

  clearDocumentBuffer(documentId: string): void {
    this.clearBuffer(`document:${documentId}`);
  }

  /**
   * Force-close all SSE connections during shutdown
   */
  closeAll(): void {
    if (this.clients.size === 0) return;

    logger.info(
      { clientCount: this.clients.size },
      'Closing all SSE connections',
    );

    for (const [, client] of this.clients) {
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
    this.eventBuffer.clear();
  }
}

export const sseService = new SSEService();
