import { PostHog } from 'posthog-node';
import { env } from '../config/env';
import { logger } from '../utils/logger';

class AnalyticsService {
  private client: PostHog | null = null;

  constructor() {
    if (env.POSTHOG_API_KEY) {
      try {
        this.client = new PostHog(env.POSTHOG_API_KEY, {
          host: env.POSTHOG_HOST,
          flushAt: 20,
          flushInterval: 10000,
        });
      } catch (error) {
        logger.error(
          { error: (error as Error).message },
          'PostHog client initialization failed',
        );
      }
    }
  }

  track(
    userId: string,
    event: string,
    properties?: Record<string, unknown>,
  ): void {
    if (!this.client) return;
    try {
      this.client.capture({ distinctId: userId, event, properties });
    } catch (error) {
      logger.error(
        { error: (error as Error).message },
        'Analytics tracking failed',
      );
    }
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown();
  }
}

export const analytics = new AnalyticsService();
