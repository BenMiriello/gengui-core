import { sql } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { imageUsage, imageUsageDaily } from '../../models/schema.js';
import { logger } from '../../utils/logger.js';

export interface RecordImageUsageParams {
  userId: string;
  mediaId?: string;
  provider: string;
  costUsd: number;
}

export class ImageUsageTrackingService {
  async recordImageUsage(params: RecordImageUsageParams): Promise<void> {
    try {
      const { userId, mediaId, provider, costUsd } = params;

      await db.insert(imageUsage).values({
        userId,
        mediaId,
        provider,
        costUsd: costUsd.toFixed(6),
      });

      const today = new Date().toISOString().split('T')[0];
      await this.updateDailyRollup({
        userId,
        date: today,
        operations: 1,
        costUsd,
        provider,
      });

      logger.debug({ userId, provider, costUsd }, 'Image usage recorded');
    } catch (error) {
      logger.error(
        { error, userId: params.userId },
        'Failed to record image usage',
      );
    }
  }

  private async updateDailyRollup(params: {
    userId: string;
    date: string;
    operations: number;
    costUsd: number;
    provider: string;
  }): Promise<void> {
    const validProviders = ['runpod', 'gemini', 'gemini-pro-image', 'local'];
    if (!validProviders.includes(params.provider)) {
      throw new Error(`Invalid provider: ${params.provider}`);
    }

    const breakdown = { [params.provider]: 1 };

    await db
      .insert(imageUsageDaily)
      .values({
        userId: params.userId,
        date: params.date,
        totalOperations: 1,
        totalCostUsd: params.costUsd.toFixed(6),
        providerBreakdown: breakdown,
      })
      .onConflictDoUpdate({
        target: [imageUsageDaily.userId, imageUsageDaily.date],
        set: {
          totalOperations: sql`${imageUsageDaily.totalOperations} + 1`,
          totalCostUsd: sql`${imageUsageDaily.totalCostUsd} + ${params.costUsd}`,
          providerBreakdown: sql`
            jsonb_set(
              ${imageUsageDaily.providerBreakdown},
              ${`{${params.provider}}`},
              to_jsonb(
                COALESCE(
                  (${imageUsageDaily.providerBreakdown}->>${params.provider})::int,
                  0
                ) + 1
              )
            )
          `,
          updatedAt: new Date(),
        },
      });
  }
}

export const imageUsageTracking = new ImageUsageTrackingService();
