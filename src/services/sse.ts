import type { Response } from 'express';
import { logger } from '../utils/logger';

interface SSEClient {
  id: string;
  channel: string;
  res: Response;
}

interface BufferedEvent {
  event: string;
  data: any;
  timestamp: number;
}

class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private eventBuffer: Map<string, BufferedEvent[]> = new Map();
  private readonly BUFFER_SIZE = 10;
  private readonly BUFFER_TTL_MS = 60000; // 1 minute

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

    this.clients.set(clientId, { id: clientId, channel, res });

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Replay buffered events for this channel
    this.replayBufferedEvents(channel, res);

    logger.debug(
      { clientId, channel, totalClients: this.clients.size },
      'SSE client connected',
    );

    res.on('close', () => {
      this.clients.delete(clientId);
      onDisconnect?.();
      logger.debug(
        { clientId, totalClients: this.clients.size },
        'SSE client disconnected',
      );
    });

    res.on('error', (error) => {
      logger.error({ error, clientId }, 'SSE client error');
      this.clients.delete(clientId);
    });

    if (res.socket) {
      res.socket.on('error', (error) => {
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
    const validEvents = buffer.filter(
      (e) => now - e.timestamp < this.BUFFER_TTL_MS,
    );

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
  private bufferEvent(channel: string, event: string, data: any) {
    if (!this.eventBuffer.has(channel)) {
      this.eventBuffer.set(channel, []);
    }

    const buffer = this.eventBuffer.get(channel)!;
    buffer.push({ event, data, timestamp: Date.now() });

    // Trim to buffer size
    if (buffer.length > this.BUFFER_SIZE) {
      buffer.shift();
    }
  }

  /**
   * Broadcast an event to all clients subscribed to a channel
   */
  broadcast(channel: string, event: string, data: any) {
    // Always buffer the event for late-joining clients
    this.bufferEvent(channel, event, data);

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
  broadcastAll(event: string, data: any) {
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
