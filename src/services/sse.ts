import { Response } from 'express';
import { logger } from '../utils/logger';

interface SSEClient {
  id: string;
  channel: string;
  res: Response;
}

class SSEService {
  private clients: Map<string, SSEClient> = new Map();

  /**
   * Add an SSE client subscribed to a channel
   * Channel format is caller-defined, e.g., "document:abc123", "node:xyz789"
   */
  addClient(clientId: string, channel: string, res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders();

    this.clients.set(clientId, { id: clientId, channel, res });

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    logger.debug({ clientId, channel, totalClients: this.clients.size }, 'SSE client connected');

    res.on('close', () => {
      this.clients.delete(clientId);
      logger.debug({ clientId, totalClients: this.clients.size }, 'SSE client disconnected');
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
   * Broadcast an event to all clients subscribed to a channel
   */
  broadcast(channel: string, event: string, data: any) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const channelClients = Array.from(this.clients.values()).filter(
      c => c.channel === channel
    );

    if (channelClients.length === 0) return;

    logger.debug({ event, channel, clientCount: channelClients.length }, 'Broadcasting SSE event');

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
}

export const sseService = new SSEService();
