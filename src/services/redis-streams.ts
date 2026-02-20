import type { Redis } from 'ioredis';
import { logger } from '../utils/logger';
import { redis } from './redis';

/**
 * Redis Streams utility for job queue operations
 *
 * ProducerStreams: ONLY non-blocking operations on SHARED client (add, ack, metrics)
 * ConsumerStreams: Extends ProducerStreams, adds blocking consume() for DEDICATED clients
 *
 * Type safety guarantee: redisStreams singleton is typed as ProducerStreams,
 * so calling .consume() on it will produce a compile-time error.
 */

export interface StreamMessage {
  id: string;
  data: Record<string, string>;
}

/**
 * Producer-only streams using SHARED Redis client.
 * ONLY non-blocking operations: add(), ack(), getPending(), getInfo()
 *
 * Use this for services that only produce messages to streams.
 * The singleton `redisStreams` is typed as ProducerStreams to prevent
 * accidental blocking operations on the shared client.
 */
export class ProducerStreams {
  protected client: Redis;
  protected ensuredGroups: Set<string> = new Set();

  constructor(client: Redis) {
    this.client = client;
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
      await this.client.xgroup(
        'CREATE',
        streamName,
        groupName,
        '0',
        'MKSTREAM',
      );
      logger.info({ streamName, groupName }, 'Created consumer group');
      this.ensuredGroups.add(key);
    } catch (error: any) {
      // BUSYGROUP error means group already exists - this is fine
      if (error.message?.includes('BUSYGROUP')) {
        logger.debug(
          { streamName, groupName },
          'Consumer group already exists',
        );
        this.ensuredGroups.add(key);
      } else {
        logger.error(
          { error, streamName, groupName },
          'Failed to create consumer group',
        );
        throw error;
      }
    }
  }

  /**
   * Add a message to a stream and notify subscribers
   * @returns Message ID
   */
  async add(streamName: string, data: Record<string, string>): Promise<string> {
    const start = Date.now();
    const args = Object.entries(data).flat();
    const result = await this.client.xadd(streamName, '*', ...args);
    // Notify subscribers that work is available (Pub/Sub pattern)
    await this.client.publish(`streams:notify:${streamName}`, '1');
    const elapsed = Date.now() - start;
    if (elapsed > 100) {
      logger.warn(
        {
          streamName,
          elapsed,
          dataSize: JSON.stringify(data).length,
          connectionStatus: this.client.status,
        },
        '[REDIS SLOW] xadd',
      );
    }
    return result as string;
  }

  /**
   * Acknowledge a message (mark as processed)
   */
  async ack(
    streamName: string,
    groupName: string,
    messageId: string,
  ): Promise<void> {
    try {
      await this.client.xack(streamName, groupName, messageId);
    } catch (error) {
      logger.error(
        { error, streamName, groupName, messageId },
        'Failed to acknowledge message',
      );
      throw error;
    }
  }

  /**
   * Parse stream entry fields from array format to object
   * Redis returns fields as [key1, value1, key2, value2, ...]
   */
  protected parseFields(fields: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) {
      result[fields[i]] = fields[i + 1];
    }
    return result;
  }

  /**
   * Get pending messages for a consumer group
   */
  async getPending(
    streamName: string,
    groupName: string,
  ): Promise<{
    count: number;
    minId: string | null;
    maxId: string | null;
    consumers: any[];
  }> {
    const pending = (await this.client.xpending(streamName, groupName)) as [
      number,
      string | null,
      string | null,
      any[],
    ];
    return {
      count: pending[0],
      minId: pending[1],
      maxId: pending[2],
      consumers: pending[3],
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
    const info = (await this.client.call(
      'XINFO',
      'STREAM',
      streamName,
    )) as any[];
    const infoMap: Record<string, any> = {};
    for (let i = 0; i < info.length; i += 2) {
      infoMap[info[i]] = info[i + 1];
    }
    return {
      length: infoMap.length ?? 0,
      firstEntry: infoMap['first-entry'],
      lastEntry: infoMap['last-entry'],
    };
  }

  /**
   * Get consumer lag (number of pending messages for a specific consumer)
   */
  async getConsumerLag(
    streamName: string,
    groupName: string,
    consumerName: string,
  ): Promise<number> {
    const info = (await this.client.call(
      'XINFO',
      'CONSUMERS',
      streamName,
      groupName,
    )) as any[];
    for (const consumerArr of info) {
      const consumerMap: Record<string, any> = {};
      for (let i = 0; i < consumerArr.length; i += 2) {
        consumerMap[consumerArr[i]] = consumerArr[i + 1];
      }
      if (consumerMap.name === consumerName) {
        return consumerMap.pending ?? 0;
      }
    }
    return 0;
  }
}

/**
 * Consumer streams requiring DEDICATED Redis client.
 * Inherits non-blocking operations from ProducerStreams, adds blocking consume()
 *
 * CRITICAL: This class MUST be used with a dedicated Redis client.
 * Never use the shared client for consuming - it will block ALL Redis operations.
 *
 * Recommended: Extend BlockingConsumer instead of instantiating this directly.
 */
export class ConsumerStreams extends ProducerStreams {
  /**
   * Consume messages from a stream using consumer groups.
   *
   * @param options.block - Block time in ms. If undefined/null, returns immediately (non-blocking).
   *                        Note: block=0 in Redis means "block forever", so we treat undefined as non-blocking.
   *
   * CRITICAL for blocking reads: Must use a dedicated Redis client, never the shared client.
   */
  async consume(
    streamName: string,
    groupName: string,
    consumerName: string,
    options: {
      count?: number;
      block?: number; // milliseconds, undefined = non-blocking
    } = {},
  ): Promise<StreamMessage | null> {
    const { count = 1, block } = options;

    try {
      let result: [string, [string, string[]][]][] | null;

      if (block !== undefined && block !== null) {
        // Blocking read
        result = (await this.client.xreadgroup(
          'GROUP',
          groupName,
          consumerName,
          'COUNT',
          count,
          'BLOCK',
          block,
          'STREAMS',
          streamName,
          '>',
        )) as [string, [string, string[]][]][] | null;
      } else {
        // Non-blocking read (no BLOCK clause = return immediately)
        result = (await this.client.xreadgroup(
          'GROUP',
          groupName,
          consumerName,
          'COUNT',
          count,
          'STREAMS',
          streamName,
          '>',
        )) as [string, [string, string[]][]][] | null;
      }

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
      logger.error(
        { error, streamName, groupName, consumerName },
        'Failed to consume from stream',
      );
      throw error;
    }
  }
}

/**
 * Singleton for producers - typed as ProducerStreams (no consume method)
 *
 * Attempting to call redisStreams.consume() will produce a TypeScript compile error:
 * TS2339: Property 'consume' does not exist on type 'ProducerStreams'
 *
 * For consuming, extend BlockingConsumer which provides a dedicated client + ConsumerStreams.
 */
export const redisStreams: ProducerStreams = new ProducerStreams(
  redis.getClient(),
);
