import { db } from '../../config/database';
import { earlyAccessSignups } from '../../models/schema';
import { logger } from '../../utils/logger';

export class EarlyAccessService {
  async signup(params: {
    email: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<{ success: boolean }> {
    const { email, ipAddress, userAgent } = params;

    await db
      .insert(earlyAccessSignups)
      .values({ email, ipAddress, userAgent })
      .onConflictDoNothing();

    logger.info({ email }, 'Early access signup');

    return { success: true };
  }
}

export const earlyAccessService = new EarlyAccessService();
