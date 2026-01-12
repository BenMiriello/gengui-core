import { redis } from './redis';
import { logger } from '../utils/logger';
import type Redis from 'ioredis';

/**
 * Redis Streams utility for job queue operations
 *
 * Provides clean abstractions for:
 * - Adding messages to streams (XADD)
 * - Consuming messages with consumer groups (XREADGROUP)
 * - Acknowledging messages (XACK)
 * - Stream metrics and monitoring
 */

export interface StreamMessage {
  id: string;
  data: Record<string, string>;
}

export class RedisStreams {
  private client: Redis;
  private ensuredGroups: Set<string> = new Set();

  constructor() {
    this.client = redis.getClient();
  }

  /**
   * Ensure consumer group exists - only attempts creation once per stream:group pair
   */
  async ensureGroupOnce(streamName: string, groupName: string): Promise<void> {
    const key = `${streamName}:${groupName}`;

    if (this.ensuredGroups.has(key)) {
      return;
    }

    try {
      await this.client.xgroup('CREATE', streamName, groupName, '0', 'MKSTREAM');
      logger.info({ streamName, groupName }, 'Created consumer group');
      this.ensuredGroups.add(key);
    } catch (error: any) {
      // BUSYGROUP error means group already exists - this is fine
      if (error.message?.includes('BUSYGROUP')) {
        logger.debug({ streamName, groupName }, 'Consumer group already exists');
        this.ensuredGroups.add(key);
      } else {
        logger.error({ error, streamName, groupName }, 'Failed to create consumer group');
        throw error;
      }
    }
  }

  /**
   * Add a message to a stream
   * @returns Message ID
   */
  async add(streamName: string, data: Record<string, string>): Promise<string> {
    const args = Object.entries(data).flat();
    return await this.client.xadd(streamName, '*', ...args);
  }

  /**
   * Consume messages from a stream using consumer groups
   * Automatically creates the consumer group if it doesn't exist
   */
  async consume(
    streamName: string,
    groupName: string,
    consumerName: string,
    options: {
      count?: number;
      block?: number; // milliseconds
    } = {}
  ): Promise<StreamMessage | null> {
    const { count = 1, block = 2000 } = options;

    try {
      const result = await this.client.xreadgroup(
        'GROUP', groupName, consumerName,
        'BLOCK', block,
        'COUNT', count,
        'STREAMS', streamName, '>'
      );

      if (!result || result.length === 0) {
        return null;
      }

      const [[, entries]] = result;
      if (entries.length === 0) {
        return null;
      }

      const [id, fields] = entries[0];
      const data = this.parseFields(fields);

      return { id, data };
    } catch (error) {
      logger.error({ error, streamName, groupName, consumerName }, 'Failed to consume from stream');
      throw error;
    }
  }

  /**
   * Acknowledge a message (mark as processed)
   */
  async ack(streamName: string, groupName: string, messageId: string): Promise<void> {
    try {
      await this.client.xack(streamName, groupName, messageId);
    } catch (error) {
      logger.error({ error, streamName, groupName, messageId }, 'Failed to acknowledge message');
      throw error;
    }
  }

  /**
   * Ensure consumer group exists (idempotent operation)
   */
  private async ensureGroup(streamName: string, groupName: string): Promise<void> {
    try {
      await this.client.xgroup('CREATE', streamName, groupName, '0', 'MKSTREAM');
      logger.debug({ streamName, groupName }, 'Created consumer group');
    } catch (error: any) {
      // BUSYGROUP error means group already exists - this is fine
      if (!error.message?.includes('BUSYGROUP')) {
        logger.error({ error, streamName, groupName }, 'Failed to create consumer group');
        throw error;
      }
    }
  }

  /**
   * Parse stream entry fields from array format to object
   * Redis returns fields as [key1, value1, key2, value2, ...]
   */
  private parseFields(fields: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      result[fields[i]] = fields[i + 1];
    }
    return result;
  }

  /**
   * Get pending messages for a consumer group
   */
  async getPending(streamName: string, groupName: string): Promise<{
    count: number;
    minId: string | null;
    maxId: string | null;
    consumers: any[];
  }> {
    const pending = await this.client.xpending(streamName, groupName);
    return {
      count: pending[0],
      minId: pending[1],
      maxId: pending[2],
      consumers: pending[3]
    };
  }

  /**
   * Get stream information
   */
  async getInfo(streamName: string): Promise<{
    length: number;
    firstEntry: any;
    lastEntry: any;
  }> {
    const info = await this.client.xinfoStream(streamName);
    return {
      length: info.length,
      firstEntry: info['first-entry'],
      lastEntry: info['last-entry']
    };
  }

  /**
   * Get consumer lag (number of pending messages for a specific consumer)
   */
  async getConsumerLag(
    streamName: string,
    groupName: string,
    consumerName: string
  ): Promise<number> {
    const info = await this.client.xinfoConsumers(streamName, groupName);
    const consumer = info.find((c: any) => c.name === consumerName);
    return consumer?.pending || 0;
  }
}

export const redisStreams = new RedisStreams();
