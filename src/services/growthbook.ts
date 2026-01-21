import { GrowthBook } from '@growthbook/growthbook';

let gbInstance: GrowthBook | null = null;

export async function getGrowthBook(): Promise<GrowthBook> {
  if (!gbInstance) {
    const apiHost = process.env.GROWTHBOOK_API_HOST;
    const clientKey = process.env.GROWTHBOOK_CLIENT_KEY;

    if (!apiHost || !clientKey) {
      console.warn(
        'GrowthBook not configured. Missing GROWTHBOOK_API_HOST or GROWTHBOOK_CLIENT_KEY. Features disabled.'
      );
      // Return a stub instance that always returns default values
      gbInstance = new GrowthBook({
        apiHost: '',
        clientKey: '',
        enableDevMode: process.env.NODE_ENV === 'development',
      });
      return gbInstance;
    }

    gbInstance = new GrowthBook({
      apiHost,
      clientKey,
      enableDevMode: process.env.NODE_ENV === 'development',
      attributes: {
        environment: process.env.NODE_ENV || 'development',
      },
      trackingCallback: (experiment, result) => {
        console.log('[GrowthBook] Experiment viewed:', {
          experimentKey: experiment.key,
          variationId: result.variationId,
        });
      },
    });

    try {
      await gbInstance.init({ timeout: 2000 });
      console.log('[GrowthBook] Initialized successfully');
    } catch (error) {
      console.error('[GrowthBook] Failed to initialize:', error);
    }
  }

  return gbInstance;
}

export async function refreshGrowthBook(): Promise<void> {
  if (gbInstance) {
    await gbInstance.refreshFeatures();
    console.log('[GrowthBook] Features refreshed');
  }
}

export function destroyGrowthBook(): void {
  if (gbInstance) {
    gbInstance.destroy();
    gbInstance = null;
    console.log('[GrowthBook] Instance destroyed');
  }
}
