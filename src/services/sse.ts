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
      'X-Accel-Buffering': 'no',
    });

    res.flushHeaders();

    this.clients.set(clientId, { id: clientId, documentId, res });

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    console.log(`SSE client connected: ${clientId} for document ${documentId}`);
    console.log(`Total SSE clients: ${this.clients.size}`);

    res.on('close', () => {
      this.clients.delete(clientId);
      console.log(`SSE client disconnected: ${clientId}`);
      console.log(`Total SSE clients: ${this.clients.size}`);
    });

    res.on('error', (error) => {
      console.error(`SSE client error for ${clientId}:`, error);
      this.clients.delete(clientId);
    });

    if (res.socket) {
      res.socket.on('error', (error) => {
        console.error(`SSE socket error for ${clientId}:`, error);
        this.clients.delete(clientId);
      });
    }
  }

  broadcastToDocument(documentId: string, event: string, data: any) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    const documentClients = Array.from(this.clients.values()).filter(
      c => c.documentId === documentId
    );

    console.log(`Broadcasting ${event} to document ${documentId}`);
    console.log(`Total clients: ${this.clients.size}, Document clients: ${documentClients.length}`);

    let successCount = 0;
    for (const [clientId, client] of this.clients) {
      if (client.documentId === documentId) {
        try {
          client.res.write(message);
          successCount++;
          console.log(`Sent ${event} to client ${clientId}`);
        } catch (error) {
          logger.error({ error, clientId }, 'Failed to send SSE message');
          this.clients.delete(clientId);
        }
      }
    }

    console.log(`Successfully sent ${event} to ${successCount} clients`);
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
