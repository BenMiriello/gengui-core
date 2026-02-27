import { usageService } from '../services/usage';
import { logger } from '../utils/logger';

async function cleanupExpiredReservations() {
  try {
    const count = await usageService.cleanupExpiredReservations();
    if (count > 0) {
      logger.info({ count }, 'Reservation cleanup completed');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to cleanup expired reservations');
  }
}

export function startCleanupReservationsJob() {
  const intervalId = setInterval(cleanupExpiredReservations, 5 * 60 * 1000);
  logger.info('Reservation cleanup job started (runs every 5 minutes)');

  return {
    stop: () => {
      clearInterval(intervalId);
      logger.info('Reservation cleanup job stopped');
    },
  };
}
