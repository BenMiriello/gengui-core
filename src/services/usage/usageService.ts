import { db } from '../../config/database';
import { quotaReservations, userSubscriptions } from '../../models/schema';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { OperationType, UserTier } from '../../config/pricing';
import {
  calculateUsageUnits,
  getTierConfig,
  TIER_CONCURRENT_LIMITS,
  RISK_THRESHOLD,
} from '../../config/pricing';
import { logger } from '../../utils/logger';
import { randomUUID } from 'node:crypto';

export class UsageQuotaExceededError extends Error {
  constructor(
    public resetDate: Date,
    public currentUsage: number,
    public quota: number,
  ) {
    super('Usage quota exceeded');
    this.name = 'UsageQuotaExceededError';
  }
}

export class ConcurrentLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentLimitExceededError';
  }
}

export class UsageService {
  async checkAndReserveQuota(params: {
    userId: string;
    operationType: OperationType;
    units?: number;
  }): Promise<{ operationId?: string }> {
    const { userId, operationType, units = 1 } = params;
    const usageUnits = calculateUsageUnits(operationType, units);

    return await db.transaction(async (tx) => {
      const [subscription] = await tx
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .for('update');

      if (!subscription) {
        throw new Error('Subscription not found');
      }

      if (subscription.tier === 'admin') {
        await tx
          .update(userSubscriptions)
          .set({
            usageConsumed: sql`${userSubscriptions.usageConsumed} + ${usageUnits}`,
            updatedAt: new Date(),
          })
          .where(eq(userSubscriptions.userId, userId));
        return {};
      }

      const now = new Date();
      let currentSubscription = subscription;

      if (now > new Date(subscription.periodEnd)) {
        currentSubscription = await this.resetPeriodWithLock(subscription, tx);
      }

      const risk = await this.calculateRisk(currentSubscription, tx);
      const operationId = randomUUID();

      if (risk >= RISK_THRESHOLD) {
        await this.strictReserveAndDeduct({
          userId,
          operationId,
          units: usageUnits,
          subscription: currentSubscription,
          tx,
        });
        return { operationId };
      } else {
        await this.optimisticCheckAndDeduct({
          userId,
          units: usageUnits,
          tx,
        });
        return {};
      }
    });
  }

  private async calculateRisk(
    subscription: typeof userSubscriptions.$inferSelect,
    tx: any,
  ): Promise<number> {
    const quotaUsage = subscription.usageConsumed / subscription.usageQuota;

    const [{ total, count }] = await tx
      .select({
        total: sql<number>`COALESCE(SUM(amount), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(quotaReservations)
      .where(
        and(
          eq(quotaReservations.userId, subscription.userId),
          gt(quotaReservations.expiresAt, new Date()),
        ),
      );

    const limits = TIER_CONCURRENT_LIMITS[subscription.tier as UserTier];
    const concurrencyUsage = count / limits.maxConcurrent;
    const inFlightCost = Number(total);
    const costUsage = inFlightCost / limits.maxInFlightCost;

    return Math.max(quotaUsage, concurrencyUsage, costUsage);
  }

  private async strictReserveAndDeduct(params: {
    userId: string;
    operationId: string;
    units: number;
    subscription: typeof userSubscriptions.$inferSelect;
    tx: any;
  }): Promise<void> {
    const { userId, operationId, units, subscription, tx } = params;

    const [reservationData] = await tx
      .select({
        total: sql<number>`COALESCE(SUM(amount), 0)`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(quotaReservations)
      .where(
        and(
          eq(quotaReservations.userId, userId),
          gt(quotaReservations.expiresAt, new Date()),
        ),
      )
      .for('update', { skipLocked: true });

    const inFlightCost = Number(reservationData.total);
    const activeCount = reservationData.count;
    const effectiveUsage = subscription.usageConsumed + inFlightCost + units;

    if (effectiveUsage > subscription.usageQuota) {
      throw new UsageQuotaExceededError(
        new Date(subscription.periodEnd),
        subscription.usageConsumed,
        subscription.usageQuota,
      );
    }

    const limits = TIER_CONCURRENT_LIMITS[subscription.tier as UserTier];

    if (activeCount >= limits.maxConcurrent) {
      throw new ConcurrentLimitExceededError(
        `Maximum concurrent operations (${limits.maxConcurrent}) reached`,
      );
    }

    if (inFlightCost + units > limits.maxInFlightCost) {
      throw new ConcurrentLimitExceededError(
        `Maximum in-flight cost (${limits.maxInFlightCost}) exceeded`,
      );
    }

    await tx.insert(quotaReservations).values({
      userId,
      operationId,
      amount: units,
      expiresAt: sql`NOW() + INTERVAL '5 minutes'`,
    });

    logger.debug({
      userId,
      operationId,
      amount: units,
      activeReservations: activeCount,
      inFlightCost: inFlightCost + units,
    }, 'Quota reservation created');
  }

  private async optimisticCheckAndDeduct(params: {
    userId: string;
    units: number;
    tx: any;
  }): Promise<void> {
    const { userId, units, tx } = params;

    const result = await tx
      .update(userSubscriptions)
      .set({
        usageConsumed: sql`${userSubscriptions.usageConsumed} + ${units}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userSubscriptions.userId, userId),
          sql`${userSubscriptions.usageConsumed} + ${units} <= ${userSubscriptions.usageQuota}`,
        ),
      )
      .returning();

    if (result.length === 0) {
      const current = await tx
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId));

      throw new UsageQuotaExceededError(
        new Date(current[0].periodEnd),
        current[0].usageConsumed,
        current[0].usageQuota,
      );
    }

    logger.debug({ userId, amount: units }, 'Usage deducted (optimistic)');
  }

  async finalizeReservation(params: {
    operationId: string;
    userId: string;
    success: boolean;
  }): Promise<void> {
    const { operationId, userId, success } = params;

    await db.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(quotaReservations)
        .where(eq(quotaReservations.operationId, operationId));

      if (!reservation) {
        logger.warn({ operationId }, 'Reservation not found for finalization');
        return;
      }

      await tx
        .delete(quotaReservations)
        .where(eq(quotaReservations.operationId, operationId));

      if (success) {
        await tx
          .update(userSubscriptions)
          .set({
            usageConsumed: sql`${userSubscriptions.usageConsumed} + ${reservation.amount}`,
            updatedAt: new Date(),
          })
          .where(eq(userSubscriptions.userId, userId));

        logger.debug({
          userId,
          operationId,
          amount: reservation.amount,
        }, 'Reservation finalized and quota deducted');
      } else {
        logger.debug({
          userId,
          operationId,
          amount: reservation.amount,
        }, 'Reservation released (operation failed)');
      }
    });
  }

  async cleanupExpiredReservations(): Promise<number> {
    const result = await db
      .delete(quotaReservations)
      .where(lt(quotaReservations.expiresAt, new Date()))
      .returning();

    const count = result.length;
    if (count > 0) {
      logger.info({ count }, 'Cleaned up expired reservations');
    }

    return count;
  }

  async deductUsage(userId: string, amount: number): Promise<void> {
    await db
      .update(userSubscriptions)
      .set({
        usageConsumed: sql`${userSubscriptions.usageConsumed} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.userId, userId));
  }

  private async resetPeriodWithLock(
    subscription: typeof userSubscriptions.$inferSelect,
    tx: any,
  ): Promise<typeof userSubscriptions.$inferSelect> {
    const now = new Date();

    if (now <= new Date(subscription.periodEnd)) {
      logger.debug(
        { userId: subscription.userId },
        'Period already reset by concurrent request',
      );
      return subscription;
    }

    const newPeriodStart = new Date(subscription.periodEnd);
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);

    const [updated] = await tx
      .update(userSubscriptions)
      .set({
        periodStart: newPeriodStart,
        periodEnd: newPeriodEnd,
        usageConsumed: 0,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.userId, subscription.userId))
      .returning();

    logger.info(
      { userId: subscription.userId, tier: subscription.tier },
      'Usage period reset',
    );

    return updated;
  }

  async getUserUsage(userId: string): Promise<{
    tier: UserTier;
    displayName: string;
    usageConsumed: number;
    usageQuota: number;
    usagePercent: number;
    periodStart: Date;
    periodEnd: Date;
    grantType: string;
  }> {
    const subscription = await this.getOrCreateSubscription(userId);
    const tierConfig = getTierConfig(subscription.tier as UserTier);

    const usagePercent =
      subscription.usageQuota > 0
        ? Math.round((subscription.usageConsumed / subscription.usageQuota) * 100)
        : 0;

    return {
      tier: subscription.tier as UserTier,
      displayName: tierConfig.displayName,
      usageConsumed: subscription.usageConsumed,
      usageQuota: subscription.usageQuota,
      usagePercent,
      periodStart: new Date(subscription.periodStart),
      periodEnd: new Date(subscription.periodEnd),
      grantType: subscription.grantType,
    };
  }

  async getOrCreateSubscription(
    userId: string,
  ): Promise<typeof userSubscriptions.$inferSelect> {
    const [existing] = await db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId))
      .limit(1);

    if (existing) {
      return existing;
    }

    const freeTierConfig = getTierConfig('free');
    const now = new Date();
    const periodStart = new Date(now);
    periodStart.setHours(periodStart.getHours() + 1, 0, 0, 0);

    const [created] = await db
      .insert(userSubscriptions)
      .values({
        userId,
        tier: 'free',
        grantType: 'standard',
        usageQuota: freeTierConfig.usageQuota,
        usageConsumed: 0,
        periodStart,
        periodEnd: periodStart,
      })
      .returning();

    return created;
  }
}

export const usageService = new UsageService();
