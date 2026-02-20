import { graphService } from './graph.service';
import type { NarrativeThread, ThreadMembership } from './graph.types';

export const graphThreads = {
  async getThreadsForDocument(
    documentId: string,
    userId: string,
  ): Promise<NarrativeThread[]> {
    const result = await graphService.query(
      `
      MATCH (nt:NarrativeThread)
      WHERE nt.documentId = $documentId AND nt.userId = $userId
      RETURN nt.id, nt.documentId, nt.userId, nt.name, nt.isPrimary, nt.color, nt.createdAt
      ORDER BY nt.createdAt
      `,
      { documentId, userId },
    );

    return result.data.map((row) => ({
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      name: row[3] as string,
      isPrimary: row[4] === true || row[4] === 'true',
      color: row[5] as string | null,
      createdAt: row[6] as string,
    }));
  },

  async getThreadById(threadId: string): Promise<NarrativeThread | null> {
    const result = await graphService.query(
      `
      MATCH (nt:NarrativeThread)
      WHERE nt.id = $threadId
      RETURN nt.id, nt.documentId, nt.userId, nt.name, nt.isPrimary, nt.color, nt.createdAt
      `,
      { threadId },
    );

    if (result.data.length === 0) return null;
    const row = result.data[0];
    return {
      id: row[0] as string,
      documentId: row[1] as string,
      userId: row[2] as string,
      name: row[3] as string,
      isPrimary: row[4] === true || row[4] === 'true',
      color: row[5] as string | null,
      createdAt: row[6] as string,
    };
  },

  async renameThread(threadId: string, name: string): Promise<void> {
    await graphService.query(
      `
      MATCH (nt:NarrativeThread)
      WHERE nt.id = $threadId
      SET nt.name = $name
      `,
      { threadId, name },
    );
  },

  async deleteThread(threadId: string): Promise<void> {
    await graphService.query(
      `
      MATCH (nt:NarrativeThread)
      WHERE nt.id = $threadId
      DETACH DELETE nt
      `,
      { threadId },
    );
  },

  async getEventsForThread(threadId: string): Promise<ThreadMembership[]> {
    const result = await graphService.query(
      `
      MATCH (e:StoryNode)-[r:BELONGS_TO_THREAD]->(nt:NarrativeThread)
      WHERE nt.id = $threadId AND e.deletedAt IS NULL
      RETURN e.id, nt.id, r.order
      ORDER BY r.order
      `,
      { threadId },
    );

    return result.data.map((row) => ({
      eventId: row[0] as string,
      threadId: row[1] as string,
      order: row[2] as number,
    }));
  },

  async getThreadsForEvent(
    eventId: string,
  ): Promise<{ threadId: string; order: number }[]> {
    const result = await graphService.query(
      `
      MATCH (e:StoryNode)-[r:BELONGS_TO_THREAD]->(nt:NarrativeThread)
      WHERE e.id = $eventId AND e.deletedAt IS NULL
      RETURN nt.id, r.order
      ORDER BY r.order
      `,
      { eventId },
    );

    return result.data.map((row) => ({
      threadId: row[0] as string,
      order: row[1] as number,
    }));
  },

  async addEventToThread(
    eventId: string,
    threadId: string,
    order: number,
  ): Promise<void> {
    await graphService.linkEventToThread(eventId, threadId, order);
  },

  async removeEventFromThread(
    eventId: string,
    threadId: string,
  ): Promise<void> {
    await graphService.query(
      `
      MATCH (e:StoryNode)-[r:BELONGS_TO_THREAD]->(nt:NarrativeThread)
      WHERE e.id = $eventId AND nt.id = $threadId
      DELETE r
      `,
      { eventId, threadId },
    );
  },

  async reorderEventInThread(
    eventId: string,
    threadId: string,
    newOrder: number,
  ): Promise<void> {
    await graphService.query(
      `
      MATCH (e:StoryNode)-[r:BELONGS_TO_THREAD]->(nt:NarrativeThread)
      WHERE e.id = $eventId AND nt.id = $threadId AND e.deletedAt IS NULL
      SET r.order = $newOrder
      `,
      { eventId, threadId, newOrder },
    );
  },
};
