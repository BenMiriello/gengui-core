import Redis from 'ioredis';
import { logger } from '../utils/logger';

class RedisService {
  private client: Redis;
  private subscriber: Redis;
  private isConnected = false;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.subscriber = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.client.on('connect', () => {
      logger.info('Redis client connected');
      this.isConnected = true;
    });

    this.client.on('error', (error) => {
      logger.error({ error }, 'Redis client error');
      this.isConnected = false;
    });

    this.subscriber.on('connect', () => {
      logger.info('Redis subscriber connected');
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

  async disconnect(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
    this.isConnected = false;
    logger.info('Redis connections closed');
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }
}

export const redis = new RedisService();
