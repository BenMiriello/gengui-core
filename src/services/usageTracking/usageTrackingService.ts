/**
 * Usage tracking service for LLM operations.
 * Records usage to database and maintains daily rollups.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { llmUsage, llmUsageDaily } from '../../models/schema';
import { logger } from '../../utils/logger';

export interface RecordUsageParams {
  userId: string;
  documentId?: string;
  requestId?: string;
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs?: number;
  stage?: number;
}

export class UsageTrackingService {
  /**
   * Record a single LLM operation.
   * Writes to llm_usage table and updates daily rollup.
   * Uses async fire-and-forget pattern (errors logged but not thrown).
   */
  async recordLLMUsage(params: RecordUsageParams): Promise<void> {
    try {
      const {
        userId,
        documentId,
        requestId,
        operation,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs,
        stage,
      } = params;

      await db.insert(llmUsage).values({
        userId,
        documentId,
        requestId,
        operation,
        model,
        inputTokens,
        outputTokens,
        costUsd: costUsd.toFixed(6),
        durationMs,
        stage,
      });

      const today = new Date().toISOString().split('T')[0];
      await this.updateDailyRollup({
        userId,
        date: today,
        operations: 1,
        inputTokens,
        outputTokens,
        costUsd,
        operation,
        model,
      });

      logger.debug(
        {
          userId,
          operation,
          inputTokens,
          outputTokens,
          costUsd,
        },
        'LLM usage recorded',
      );
    } catch (error) {
      logger.error(
        {
          error: (error as Error).message,
          userId: params.userId,
          operation: params.operation,
        },
        'Failed to record LLM usage',
      );
    }
  }

  /**
   * Update daily rollup for a user (incremental upsert).
   * Updates both user-specific and global rollups.
   */
  private async updateDailyRollup(params: {
    userId: string;
    date: string;
    operations: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    operation: string;
    model: string;
  }): Promise<void> {
    const {
      userId,
      date,
      operations,
      inputTokens,
      outputTokens,
      costUsd,
      operation,
      model,
    } = params;

    await this.upsertRollup({
      userId,
      date,
      operations,
      inputTokens,
      outputTokens,
      costUsd,
      operation,
      model,
    });

    await this.upsertRollup({
      userId: null,
      date,
      operations,
      inputTokens,
      outputTokens,
      costUsd,
      operation,
      model,
    });
  }

  /**
   * Upsert rollup row (insert or increment).
   */
  private async upsertRollup(params: {
    userId: string | null;
    date: string;
    operations: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    operation: string;
    model: string;
  }): Promise<void> {
    const {
      userId,
      date,
      operations,
      inputTokens,
      outputTokens,
      costUsd,
      operation,
      model,
    } = params;

    const existing = await db
      .select()
      .from(llmUsageDaily)
      .where(
        userId
          ? and(eq(llmUsageDaily.userId, userId), eq(llmUsageDaily.date, date))
          : and(
              sql`${llmUsageDaily.userId} IS NULL`,
              eq(llmUsageDaily.date, date),
            ),
      )
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0];
      const operationBreakdown =
        (row.operationBreakdown as Record<string, number>) || {};
      const modelBreakdown =
        (row.modelBreakdown as Record<string, number>) || {};

      operationBreakdown[operation] =
        (operationBreakdown[operation] || 0) + operations;
      modelBreakdown[model] = (modelBreakdown[model] || 0) + operations;

      await db
        .update(llmUsageDaily)
        .set({
          totalOperations: row.totalOperations + operations,
          totalInputTokens: Number(row.totalInputTokens) + inputTokens,
          totalOutputTokens: Number(row.totalOutputTokens) + outputTokens,
          totalCostUsd: (parseFloat(row.totalCostUsd) + costUsd).toFixed(6),
          operationBreakdown,
          modelBreakdown,
          updatedAt: new Date(),
        })
        .where(eq(llmUsageDaily.id, row.id));
    } else {
      await db.insert(llmUsageDaily).values({
        userId,
        date,
        totalOperations: operations,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalCostUsd: costUsd.toFixed(6),
        operationBreakdown: { [operation]: operations },
        modelBreakdown: { [model]: operations },
      });
    }
  }

  /**
   * Get usage stats for a user or globally.
   */
  async getUsageStats(params: {
    userId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{
    totalCost: number;
    totalOperations: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  }> {
    const { userId, startDate, endDate } = params;

    const conditions = [];
    if (userId) {
      conditions.push(eq(llmUsageDaily.userId, userId));
    } else {
      conditions.push(sql`${llmUsageDaily.userId} IS NULL`);
    }
    if (startDate) {
      conditions.push(sql`${llmUsageDaily.date} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${llmUsageDaily.date} <= ${endDate}`);
    }

    const rows = await db
      .select()
      .from(llmUsageDaily)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const totals = rows.reduce(
      (acc, row) => ({
        totalCost: acc.totalCost + parseFloat(row.totalCostUsd),
        totalOperations: acc.totalOperations + row.totalOperations,
        totalInputTokens: acc.totalInputTokens + Number(row.totalInputTokens),
        totalOutputTokens:
          acc.totalOutputTokens + Number(row.totalOutputTokens),
      }),
      {
        totalCost: 0,
        totalOperations: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
    );

    return totals;
  }
}

export const usageTrackingService = new UsageTrackingService();
