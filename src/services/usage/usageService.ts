import { db } from '../../config/database';
import { userSubscriptions } from '../../models/schema';
import { eq, sql } from 'drizzle-orm';
import type { OperationType, UserTier } from '../../config/pricing';
import { calculateUsageUnits, getTierConfig } from '../../config/pricing';
import { logger } from '../../utils/logger';

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

export class UsageService {
  async checkAndReserveQuota(params: {
    userId: string;
    operationType: OperationType;
    units?: number;
  }): Promise<void> {
    const { userId, operationType, units = 1 } = params;

    const usageUnits = calculateUsageUnits(operationType, units);
    const subscription = await this.getOrCreateSubscription(userId);

    if (subscription.tier === 'admin') {
      await this.deductUsage(userId, usageUnits);
      return;
    }

    const now = new Date();
    let currentSubscription = subscription;

    if (now > new Date(subscription.periodEnd)) {
      currentSubscription = await this.resetPeriod(subscription);
    }

    const newUsage = currentSubscription.usageConsumed + usageUnits;

    if (newUsage > currentSubscription.usageQuota) {
      logger.warn({
        userId,
        required: usageUnits,
        available: currentSubscription.usageQuota - currentSubscription.usageConsumed,
        tier: currentSubscription.tier,
        operationType,
      }, 'Quota exceeded');

      throw new UsageQuotaExceededError(
        new Date(currentSubscription.periodEnd),
        currentSubscription.usageConsumed,
        currentSubscription.usageQuota,
      );
    }

    await this.deductUsage(userId, usageUnits);
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

  async resetPeriod(
    subscription: typeof userSubscriptions.$inferSelect,
  ): Promise<typeof userSubscriptions.$inferSelect> {
    const newPeriodStart = new Date(subscription.periodEnd);
    const newPeriodEnd = new Date(newPeriodStart);
    newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);

    const [updated] = await db
      .update(userSubscriptions)
      .set({
        periodStart: newPeriodStart,
        periodEnd: newPeriodEnd,
        usageConsumed: 0,
        updatedAt: new Date(),
      })
      .where(eq(userSubscriptions.userId, subscription.userId))
      .returning();

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
