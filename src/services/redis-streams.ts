import type { Redis } from 'ioredis';
import { logger } from '../utils/logger';
import { redis } from './redis';

/**
 * Redis Streams utility for job queue operations.
 *
 * ProducerStreams: ONLY non-blocking operations on SHARED client (add, ack, metrics)
 *
 * Note: Consuming is now handled by job workers using database polling with
 * SELECT FOR UPDATE SKIP LOCKED. Redis pub/sub is used only for notifications
 * to reduce polling latency.
 */

export interface StreamMessage {
  id: string;
  data: Record<string, string>;
}

/**
 * Producer-only streams using SHARED Redis client.
 * ONLY non-blocking operations: add(), ack(), getPending(), getInfo()
 *
 * Used for:
 * - Adding jobs to streams (consumed by external services like inference-worker)
 * - Pub/sub notifications for job workers
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
    } catch (error: unknown) {
      const err = error as Error;
      if (err.message?.includes('BUSYGROUP')) {
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
   * Get pending messages for a consumer group
   */
  async getPending(
    streamName: string,
    groupName: string,
  ): Promise<{
    count: number;
    minId: string | null;
    maxId: string | null;
    consumers: unknown[];
  }> {
    const pending = (await this.client.xpending(streamName, groupName)) as [
      number,
      string | null,
      string | null,
      unknown[],
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
    firstEntry: unknown;
    lastEntry: unknown;
  }> {
    const info = (await this.client.call(
      'XINFO',
      'STREAM',
      streamName,
    )) as unknown[];
    const infoMap: Record<string, unknown> = {};
    for (let i = 0; i < info.length; i += 2) {
      infoMap[info[i] as string] = info[i + 1];
    }
    return {
      length: (infoMap.length as number) ?? 0,
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
    )) as unknown[][];
    for (const consumerArr of info) {
      const consumerMap: Record<string, unknown> = {};
      for (let i = 0; i < consumerArr.length; i += 2) {
        consumerMap[consumerArr[i] as string] = consumerArr[i + 1];
      }
      if (consumerMap.name === consumerName) {
        return (consumerMap.pending as number) ?? 0;
      }
    }
    return 0;
  }
}

/**
 * Singleton for producers - typed as ProducerStreams
 *
 * Used for:
 * - Adding to generation:stream (consumed by inference-worker)
 * - Pub/sub notifications to job workers
 */
export const redisStreams: ProducerStreams = new ProducerStreams(
  redis.getClient(),
);
