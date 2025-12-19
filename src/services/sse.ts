import { Response } from 'express';
import { logger } from '../utils/logger';

interface SSEClient {
  id: string;
  documentId: string;
  res: Response;
}

class SSEService {
  private clients: Map<string, SSEClient> = new Map();

  addClient(clientId: string, documentId: string, res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    this.clients.set(clientId, { id: clientId, documentId, res });

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    logger.info({ clientId, documentId }, 'SSE client connected');

    res.on('close', () => {
      this.clients.delete(clientId);
      logger.info({ clientId, documentId }, 'SSE client disconnected');
    });
  }

  broadcastToDocument(documentId: string, event: string, data: any) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const [clientId, client] of this.clients) {
      if (client.documentId === documentId) {
        try {
          client.res.write(message);
        } catch (error) {
          logger.error({ error, clientId }, 'Failed to send SSE message');
          this.clients.delete(clientId);
        }
      }
    }
  }

  broadcast(event: string, data: any) {
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

  getClientCount(): number {
    return this.clients.size;
  }
}

export const sseService = new SSEService();
