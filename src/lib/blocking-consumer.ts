import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { ConsumerStreams } from '../services/redis-streams';

/**
 * Base class for Redis Stream consumers with blocking operations.
 *
 * WHY: Blocking operations (XREADGROUP with BLOCK, Pub/Sub subscribe) on shared
 * Redis clients block ALL other Redis operations across the entire application,
 * causing 6-8 second delays. This base class enforces dedicated client creation
 * and provides a consistent pattern for all consumers.
 *
 * USAGE:
 * ```typescript
 * class MyConsumer extends BlockingConsumer {
 *   constructor() {
 *     super('my-service-name');
 *   }
 *
 *   protected async onStart() {
 *     await this.streams.ensureGroupOnce('my-stream', 'my-group');
 *   }
 *
 *   protected async consumeLoop() {
 *     const consumerName = `my-consumer-${process.pid}`;
 *     while (this.isRunning) {
 *       const msg = await this.streams.consume('stream', 'group', consumerName, { block: 2000 });
 *       if (msg) {
 *         await this.handleMessage(msg);
 *         await this.streams.ack('stream', 'group', msg.id);
 *       }
 *     }
 *   }
 * }
 * ```
 */
export abstract class BlockingConsumer {
  protected isRunning = false;
  protected redisClient: Redis;
  protected streams: ConsumerStreams;
  private serviceName: string;
  private loopPromise: Promise<void> | null = null;

  constructor(serviceName: string) {
    this.serviceName = serviceName;

    // Create dedicated Redis client with optimized config
    this.redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 0,
      commandTimeout: 15000,
      connectTimeout: 10000,
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: true,
      keepAlive: 0,              // Disable (prevents issues)
      family: 4,                 // Force IPv4
      enableAutoPipelining: false, // Disable (prevents queue buildup)
    });

    this.redisClient.on('error', (error) => {
      logger.error({ error, service: this.serviceName }, 'Redis client error');
    });

    this.streams = new ConsumerStreams(this.redisClient);
  }

  async start() {
    if (this.isRunning) {
      logger.warn({ service: this.serviceName }, 'Consumer already running');
      return;
    }

    this.isRunning = true;
    logger.info({ service: this.serviceName }, 'Starting consumer...');

    await this.onStart();
    this.loopPromise = this.consumeLoop();

    logger.info({ service: this.serviceName }, 'Consumer started successfully');
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info({ service: this.serviceName }, 'Stopping consumer...');
    this.isRunning = false;

    // Force disconnect to unblock any pending XREADGROUP calls
    this.redisClient.disconnect();

    // Wait for the consume loop to exit, but with a timeout
    if (this.loopPromise) {
      const loopTimeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn({ service: this.serviceName }, 'Consumer loop did not exit in time, continuing shutdown');
          resolve();
        }, 3000);
      });
      await Promise.race([this.loopPromise, loopTimeout]);
      this.loopPromise = null;
    }

    await this.onStop();
    logger.info({ service: this.serviceName }, 'Consumer stopped');
  }

  /**
   * Override to perform setup before consuming starts (e.g., ensure consumer groups exist)
   */
  protected async onStart(): Promise<void> {}

  /**
   * Override to perform cleanup when consumer stops
   */
  protected async onStop(): Promise<void> {}

  /**
   * Implement the main consume loop. This method should run while this.isRunning is true.
   * Must handle Redis disconnect errors gracefully (check !this.isRunning before logging errors).
   */
  protected abstract consumeLoop(): Promise<void>;
}
