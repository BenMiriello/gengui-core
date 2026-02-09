import Redis from 'ioredis';
import { logger } from '../utils/logger';

class RedisService {
  private client: Redis;
  private subscriber: Redis;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }

    logger.info({ redisUrl }, 'Connecting to Redis');

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 0,
      commandTimeout: 15000,
      connectTimeout: 10000,
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: true, // Allow queueing during startup
      keepAlive: 0, // Disable TCP keepalive (was causing issues)
      family: 4, // Force IPv4
      enableAutoPipelining: false, // Disable auto pipelining (was causing queue buildup)
    });

    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 0,
      commandTimeout: 15000,
      connectTimeout: 10000,
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: true,
      keepAlive: 0,
      family: 4,
      enableAutoPipelining: false,
    });

    this.client.on('connect', () => {
      logger.info('Redis client connected');
    });

    this.client.on('ready', () => {
      logger.info({ status: this.client.status, mode: this.client.mode }, 'Redis client ready');
    });

    this.client.on('error', (error) => {
      logger.error({ error }, 'Redis client error');
    });

    this.client.on('close', () => {
      logger.info('Redis client connection closed');
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis client reconnecting');
    });

    // Monitor command queue size
    this.monitorInterval = setInterval(() => {
      const commandQueue = (this.client as any).commandQueue;
      const offlineQueue = (this.client as any).offlineQueue;
      if (commandQueue && commandQueue.length > 0) {
        logger.warn({ queueLength: commandQueue.length }, '[REDIS] Commands in queue');
      }
      if (offlineQueue && offlineQueue.length > 0) {
        logger.warn(
          { offlineQueueLength: offlineQueue.length },
          '[REDIS] Commands in offline queue'
        );
      }
    }, 1000);

    this.subscriber.on('connect', () => {
      logger.info('Redis subscriber connected');
    });

    this.subscriber.on('ready', () => {
      logger.info('Redis subscriber ready');
    });

    this.subscriber.on('error', (error) => {
      logger.error({ error }, 'Redis subscriber error');
    });
  }

  async addJob(jobId: string, jobData: Record<string, string>): Promise<void> {
    await this.client.hset(`jobs:${jobId}`, jobData);
    await this.client.lpush('generation:queue', jobId);
  }

  async getJob(jobId: string): Promise<Record<string, string> | null> {
    const data = await this.client.hgetall(`jobs:${jobId}`);
    return Object.keys(data).length > 0 ? data : null;
  }

  async updateJob(jobId: string, updates: Record<string, string>): Promise<void> {
    await this.client.hset(`jobs:${jobId}`, updates);
  }

  async subscribe(
    pattern: string,
    callback: (channel: string, message: string) => void
  ): Promise<void> {
    await this.subscriber.psubscribe(pattern);

    this.subscriber.on('pmessage', (subscribedPattern, channel, message) => {
      if (subscribedPattern === pattern) {
        callback(channel, message);
      }
    });
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  async brpop(key: string, timeout: number): Promise<[string, string] | null> {
    return this.client.brpop(key, timeout);
  }

  async lpush(key: string, value: string): Promise<number> {
    return this.client.lpush(key, value);
  }

  async llen(key: string): Promise<number> {
    return this.client.llen(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const start = Date.now();
    const result = await this.client.zadd(key, score, member);
    const elapsed = Date.now() - start;

    if (elapsed > 100) {
      logger.warn(
        {
          key,
          elapsed,
          connectionStatus: this.client.status,
        },
        '[REDIS SLOW] zadd'
      );
    }
    return result;
  }

  async zcard(key: string): Promise<number> {
    return this.client.zcard(key);
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    return this.client.zremrangebyscore(key, min, max);
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.zrange(key, start, stop);
  }

  async eval(script: string, numKeys: number, keys: string[], args: string[]): Promise<any> {
    return this.client.eval(script, numKeys, ...keys, ...args);
  }

  async expire(key: string, seconds: number): Promise<number> {
    const start = Date.now();
    const result = await this.client.expire(key, seconds);
    const elapsed = Date.now() - start;
    if (elapsed > 100) {
      logger.warn(
        { key, seconds, elapsed, connectionStatus: this.client.status },
        '[REDIS SLOW] expire'
      );
    }
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    await this.client.quit();
    await this.subscriber.quit();
    logger.info('Redis connections closed');
  }

  getConnectionStatus(): boolean {
    // Check actual Redis client status instead of just the flag
    // 'ready' means connected and ready to accept commands
    return this.client.status === 'ready' || this.client.status === 'connect';
  }

  getClient(): Redis {
    return this.client;
  }

  /**
   * Get dedicated subscriber client for Pub/Sub operations
   *
   * CRITICAL: Pub/Sub subscribe() is a blocking operation that puts the connection
   * in subscriber mode. Always use this dedicated client for Pub/Sub, never the
   * main client.
   */
  getSubscriber(): Redis {
    return this.subscriber;
  }
}

export const redis = new RedisService();
