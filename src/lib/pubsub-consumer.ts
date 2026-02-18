import Redis from 'ioredis';
import { ConsumerStreams, type StreamMessage } from '../services/redis-streams';
import { logger } from '../utils/logger';

/**
 * Base class for Pub/Sub-driven Redis Stream consumers.
 *
 * WHY: Replaces continuous BLOCK polling with event-driven notifications.
 * Instead of polling every 2 seconds (burning ~180 requests/min idle),
 * consumers wait on a Pub/Sub channel and only read when notified.
 *
 * COST REDUCTION: ~2 commands per actual message vs ~30+/min idle polling.
 *
 * HOW IT WORKS:
 * 1. On startup: process any pending messages (XREADGROUP)
 * 2. SUBSCRIBE to notification channel(s)
 * 3. Wait for notification (indefinitely, no polling)
 * 4. On notification: XREADGROUP until empty (no blocking)
 * 5. ACK each message
 * 6. Return to waiting
 * 7. Fallback: every 60s, check for pending (handles missed notifications)
 *
 * USAGE:
 * ```typescript
 * class MyConsumer extends PubSubConsumer {
 *   protected streamName = 'my-stream';
 *   protected groupName = 'my-processors';
 *   protected consumerName = `my-processor-${process.pid}`;
 *
 *   protected async handleMessage(message: StreamMessage) {
 *     // Process the message
 *     // ACK is handled automatically after this returns
 *   }
 * }
 * ```
 */
export abstract class PubSubConsumer {
  protected isRunning = false;
  private subscriber: Redis;
  private streamClient: Redis;
  protected streams: ConsumerStreams;
  private serviceName: string;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private processingPromise: Promise<void> | null = null;

  protected abstract streamName: string;
  protected abstract groupName: string;
  protected abstract consumerName: string;
  protected abstract handleMessage(message: StreamMessage): Promise<void>;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const redisConfig = {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
      commandTimeout: 15000,
      connectTimeout: 10000,
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: true,
      keepAlive: 0,
      family: 4 as const,
      enableAutoPipelining: false,
    };

    // Dedicated client for Pub/Sub (SUBSCRIBE blocks the connection)
    this.subscriber = new Redis(redisUrl, redisConfig);
    this.subscriber.on('error', (error) => {
      logger.error({ error, service: this.serviceName }, 'Subscriber client error');
    });

    // Dedicated client for stream operations (XREADGROUP)
    this.streamClient = new Redis(redisUrl, redisConfig);
    this.streamClient.on('error', (error) => {
      logger.error({ error, service: this.serviceName }, 'Stream client error');
    });

    this.streams = new ConsumerStreams(this.streamClient);
  }

  async start() {
    if (this.isRunning) {
      logger.warn({ service: this.serviceName }, 'Consumer already running');
      return;
    }

    this.isRunning = true;
    logger.info({ service: this.serviceName }, 'Starting Pub/Sub consumer...');

    await this.streams.ensureGroupOnce(this.streamName, this.groupName);

    // Process any pending messages before subscribing
    await this.consumeAllPending();

    // Start subscription
    this.subscribeLoop();

    // Start fallback check (handles missed notifications)
    this.startFallbackCheck();

    logger.info({ service: this.serviceName }, 'Pub/Sub consumer started successfully');
  }

  private subscribeLoop() {
    const channel = `streams:notify:${this.streamName}`;

    this.subscriber.subscribe(channel, (err) => {
      if (err) {
        logger.error({ error: err, channel, service: this.serviceName }, 'Subscribe failed');
      } else {
        logger.debug({ channel, service: this.serviceName }, 'Subscribed to notification channel');
      }
    });

    this.subscriber.on('message', async (ch, _msg) => {
      if (ch === channel && this.isRunning) {
        // Avoid overlapping processing
        if (this.processingPromise) {
          return;
        }
        this.processingPromise = this.consumeAllPending();
        await this.processingPromise;
        this.processingPromise = null;
      }
    });
  }

  private async consumeAllPending() {
    while (this.isRunning) {
      try {
        // Non-blocking read - return immediately if empty (no block param = immediate)
        const msg = await this.streams.consume(this.streamName, this.groupName, this.consumerName, {
          count: 1,
        });

        if (!msg) break;

        try {
          await this.handleMessage(msg);
        } catch (error) {
          logger.error(
            { error, messageId: msg.id, service: this.serviceName },
            'Error processing message'
          );
        }

        // ACK after processing (even on error, to avoid reprocessing bad messages)
        await this.streams.ack(this.streamName, this.groupName, msg.id);
      } catch (error: any) {
        // Shutdown in progress
        if (!this.isRunning) break;

        // Redis disconnected
        if (error?.message?.includes('Connection') || error?.code === 'ERR_CONNECTION_CLOSED') {
          break;
        }

        logger.error({ error, service: this.serviceName }, 'Error in consume loop');
        break;
      }
    }
  }

  private startFallbackCheck() {
    // Every 60s, check for pending messages (handles missed notifications)
    this.fallbackInterval = setInterval(async () => {
      if (this.isRunning && !this.processingPromise) {
        this.processingPromise = this.consumeAllPending();
        await this.processingPromise;
        this.processingPromise = null;
      }
    }, 60000);
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info({ service: this.serviceName }, 'Stopping Pub/Sub consumer...');
    this.isRunning = false;

    // Clear fallback interval
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }

    // Unsubscribe and disconnect
    try {
      await this.subscriber.unsubscribe();
    } catch {
      // Ignore errors during shutdown
    }

    this.subscriber.disconnect();
    this.streamClient.disconnect();

    // Wait for any in-flight processing
    if (this.processingPromise) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn({ service: this.serviceName }, 'Processing did not complete in time');
          resolve();
        }, 3000);
      });
      await Promise.race([this.processingPromise, timeout]);
    }

    logger.info({ service: this.serviceName }, 'Pub/Sub consumer stopped');
  }
}

/**
 * Base class for multi-stream Pub/Sub consumers.
 *
 * Use this when a single consumer needs to process messages from multiple streams.
 * Each stream has its own notification channel, but all are handled by one consumer.
 */
export abstract class MultiStreamPubSubConsumer {
  protected isRunning = false;
  private subscriber: Redis;
  private streamClient: Redis;
  protected streams: ConsumerStreams;
  private serviceName: string;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private processingPromises: Map<string, Promise<void>> = new Map();

  protected abstract streamConfigs: Array<{
    streamName: string;
    groupName: string;
    consumerName: string;
  }>;

  protected abstract handleMessage(
    streamName: string,
    groupName: string,
    message: StreamMessage
  ): Promise<void>;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
    const redisConfig = {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
      commandTimeout: 15000,
      connectTimeout: 10000,
      enableReadyCheck: true,
      lazyConnect: false,
      enableOfflineQueue: true,
      keepAlive: 0,
      family: 4 as const,
      enableAutoPipelining: false,
    };

    this.subscriber = new Redis(redisUrl, redisConfig);
    this.subscriber.on('error', (error) => {
      logger.error({ error, service: this.serviceName }, 'Subscriber client error');
    });

    this.streamClient = new Redis(redisUrl, redisConfig);
    this.streamClient.on('error', (error) => {
      logger.error({ error, service: this.serviceName }, 'Stream client error');
    });

    this.streams = new ConsumerStreams(this.streamClient);
  }

  async start() {
    if (this.isRunning) {
      logger.warn({ service: this.serviceName }, 'Consumer already running');
      return;
    }

    this.isRunning = true;
    logger.info({ service: this.serviceName }, 'Starting multi-stream Pub/Sub consumer...');

    // Ensure all consumer groups exist
    for (const config of this.streamConfigs) {
      await this.streams.ensureGroupOnce(config.streamName, config.groupName);
    }

    // Process any pending messages before subscribing
    for (const config of this.streamConfigs) {
      await this.consumeAllPendingForStream(config);
    }

    // Subscribe to all notification channels
    this.subscribeLoop();

    // Start fallback check
    this.startFallbackCheck();

    logger.info({ service: this.serviceName }, 'Multi-stream Pub/Sub consumer started');
  }

  private subscribeLoop() {
    const channels = this.streamConfigs.map((c) => `streams:notify:${c.streamName}`);

    this.subscriber.subscribe(...channels, (err) => {
      if (err) {
        logger.error({ error: err, channels, service: this.serviceName }, 'Subscribe failed');
      } else {
        logger.debug({ channels, service: this.serviceName }, 'Subscribed to notification channels');
      }
    });

    this.subscriber.on('message', async (ch, _msg) => {
      if (!this.isRunning) return;

      // Find which stream this notification is for
      const streamName = ch.replace('streams:notify:', '');
      const config = this.streamConfigs.find((c) => c.streamName === streamName);
      if (!config) return;

      // Avoid overlapping processing for the same stream
      if (this.processingPromises.has(streamName)) {
        return;
      }

      const promise = this.consumeAllPendingForStream(config);
      this.processingPromises.set(streamName, promise);
      await promise;
      this.processingPromises.delete(streamName);
    });
  }

  private async consumeAllPendingForStream(config: {
    streamName: string;
    groupName: string;
    consumerName: string;
  }) {
    while (this.isRunning) {
      try {
        // Non-blocking read - return immediately if empty (no block param = immediate)
        const msg = await this.streams.consume(
          config.streamName,
          config.groupName,
          config.consumerName,
          { count: 1 }
        );

        if (!msg) break;

        try {
          await this.handleMessage(config.streamName, config.groupName, msg);
        } catch (error) {
          logger.error(
            { error, messageId: msg.id, streamName: config.streamName, service: this.serviceName },
            'Error processing message'
          );
        }

        await this.streams.ack(config.streamName, config.groupName, msg.id);
      } catch (error: any) {
        if (!this.isRunning) break;
        if (error?.message?.includes('Connection') || error?.code === 'ERR_CONNECTION_CLOSED') {
          break;
        }
        logger.error(
          { error, streamName: config.streamName, service: this.serviceName },
          'Error in consume loop'
        );
        break;
      }
    }
  }

  private startFallbackCheck() {
    this.fallbackInterval = setInterval(async () => {
      if (!this.isRunning) return;

      for (const config of this.streamConfigs) {
        if (!this.processingPromises.has(config.streamName)) {
          const promise = this.consumeAllPendingForStream(config);
          this.processingPromises.set(config.streamName, promise);
          await promise;
          this.processingPromises.delete(config.streamName);
        }
      }
    }, 60000);
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info({ service: this.serviceName }, 'Stopping multi-stream Pub/Sub consumer...');
    this.isRunning = false;

    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }

    try {
      await this.subscriber.unsubscribe();
    } catch {
      // Ignore errors during shutdown
    }

    this.subscriber.disconnect();
    this.streamClient.disconnect();

    // Wait for all in-flight processing
    const promises = Array.from(this.processingPromises.values());
    if (promises.length > 0) {
      const timeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn({ service: this.serviceName }, 'Processing did not complete in time');
          resolve();
        }, 3000);
      });
      await Promise.race([Promise.all(promises), timeout]);
    }

    logger.info({ service: this.serviceName }, 'Multi-stream Pub/Sub consumer stopped');
  }
}
