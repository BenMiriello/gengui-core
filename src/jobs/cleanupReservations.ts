import { usageService } from '../services/usage';
import { logger } from '../utils/logger';

export async function cleanupExpiredReservations() {
  try {
    const count = await usageService.cleanupExpiredReservations();
    if (count > 0) {
      logger.info({ count }, 'Reservation cleanup completed');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup expired reservations');
  }
}

setInterval(cleanupExpiredReservations, 5 * 60 * 1000);

logger.info('Reservation cleanup job started (runs every 5 minutes)');
