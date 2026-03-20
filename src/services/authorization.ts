import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../config/database';
import { documents } from '../models/schema';
import { logger } from '../utils/logger';
import { graphService } from './graph/graph.service';

type ChannelType = 'user' | 'document' | 'node';

interface ParsedChannel {
  type: ChannelType;
  id: string;
}

// Strict: type:id where id is alphanumeric/hyphens/underscores
const CHANNEL_PATTERN = /^(user|document|node):([a-zA-Z0-9_-]+)$/;

class AuthorizationService {
  parseChannel(channel: string): ParsedChannel | null {
    const match = channel.match(CHANNEL_PATTERN);
    if (!match) return null;
    return { type: match[1] as ChannelType, id: match[2] };
  }

  async canAccessDocument(
    userId: string,
    documentId: string,
  ): Promise<boolean> {
    const [doc] = await db
      .select({ userId: documents.userId })
      .from(documents)
      .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
      .limit(1);
    return doc?.userId === userId;
  }

  async canAccessNode(userId: string, nodeId: string): Promise<boolean> {
    const node = await graphService.getStoryNodeById(nodeId, userId);
    return node !== null;
  }

  async validateChannelAccess(
    userId: string,
    channel: string,
  ): Promise<{ valid: true } | { valid: false; reason: string; code: string }> {
    const parsed = this.parseChannel(channel);

    if (!parsed) {
      return {
        valid: false,
        reason: 'Invalid channel format',
        code: 'INVALID_INPUT',
      };
    }

    switch (parsed.type) {
      case 'user':
        if (parsed.id !== userId) {
          logger.warn({ userId, channel }, 'Unauthorized user channel access');
          return {
            valid: false,
            reason: 'Cannot access this channel',
            code: 'FORBIDDEN',
          };
        }
        return { valid: true };

      case 'document':
        if (!(await this.canAccessDocument(userId, parsed.id))) {
          logger.warn(
            { userId, channel },
            'Unauthorized document channel access',
          );
          return {
            valid: false,
            reason: 'Cannot access this channel',
            code: 'FORBIDDEN',
          };
        }
        return { valid: true };

      case 'node':
        if (!(await this.canAccessNode(userId, parsed.id))) {
          logger.warn({ userId, channel }, 'Unauthorized node channel access');
          return {
            valid: false,
            reason: 'Cannot access this channel',
            code: 'FORBIDDEN',
          };
        }
        return { valid: true };
    }
  }
}

export const authorizationService = new AuthorizationService();
