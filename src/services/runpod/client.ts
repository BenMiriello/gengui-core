import { logger } from '../../utils/logger';
import type { RunPodJobInput, RunPodJobPolicy, RunPodJobStatusResponse } from './types';

class RunPodClient {
  private endpoint: any;
  private enabled: boolean;
  private initPromise: Promise<void> | null = null;

  constructor() {
    const apiKey = process.env.RUNPOD_API_KEY || '';
    const endpointId = process.env.RUNPOD_ENDPOINT_ID || '';

    this.enabled = process.env.ENABLE_RUNPOD === 'true' && !!apiKey && !!endpointId;

    if (this.enabled) {
      // Dynamic import for ESM module
      this.initPromise = this.initializeEndpoint(apiKey, endpointId);
    } else {
      logger.warn('RunPod API key or endpoint ID not configured. RunPod integration disabled.');
    }
  }

  private async initializeEndpoint(apiKey: string, endpointId: string): Promise<void> {
    try {
      // Dynamic import because runpod-sdk is ESM-only
      const runpodSdkModule = await import('runpod-sdk');
      const runpodSdk = runpodSdkModule.default || runpodSdkModule;

      const runpod = runpodSdk(apiKey);
      this.endpoint = runpod.endpoint(endpointId);

      logger.info({ endpointId }, 'RunPod client initialized successfully');
    } catch (error) {
      logger.error({ error }, 'Failed to initialize RunPod client');
      this.enabled = false;
      throw error;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Submit a job to RunPod serverless endpoint using official SDK
   * @param input Job input data
   * @param policy Optional per-job policy (execution timeout, priority, etc.)
   */
  async submitJob(input: RunPodJobInput, policy?: RunPodJobPolicy): Promise<string> {
    await this.ensureInitialized();

    if (!this.endpoint) {
      throw new Error('RunPod not configured');
    }

    try {
      const jobPayload = { input, ...(policy && { policy }) };

      const result = await this.endpoint.run(jobPayload);

      logger.info(
        {
          runpodJobId: result.id,
          mediaId: input.mediaId,
          executionTimeout: policy?.executionTimeout
        },
        'Job submitted to RunPod successfully'
      );

      return result.id;
    } catch (error) {
      logger.error({ error, mediaId: input.mediaId }, 'Failed to submit job to RunPod');
      throw error;
    }
  }

  /**
   * Check job status on RunPod using official SDK
   */
  async getJobStatus(runpodJobId: string): Promise<RunPodJobStatusResponse> {
    await this.ensureInitialized();

    if (!this.endpoint) {
      throw new Error('RunPod not configured');
    }

    try {
      const status = await this.endpoint.status(runpodJobId);
      return status as RunPodJobStatusResponse;
    } catch (error) {
      logger.error({ error, runpodJobId }, 'Failed to check RunPod job status');
      throw error;
    }
  }

  /**
   * Cancel a job on RunPod using official SDK
   */
  async cancelJob(runpodJobId: string): Promise<void> {
    await this.ensureInitialized();

    if (!this.endpoint) {
      throw new Error('RunPod not configured');
    }

    try {
      await this.endpoint.cancel(runpodJobId);
      logger.info({ runpodJobId }, 'Job cancelled on RunPod successfully');
    } catch (error) {
      logger.error({ error, runpodJobId }, 'Failed to cancel RunPod job');
      throw error;
    }
  }

  /**
   * Get endpoint health status
   */
  async getEndpointHealth(): Promise<any> {
    await this.ensureInitialized();

    if (!this.endpoint) {
      throw new Error('RunPod not configured');
    }

    try {
      const health = await this.endpoint.health();
      logger.debug({ health }, 'Retrieved endpoint health');
      return health;
    } catch (error) {
      logger.error({ error }, 'Failed to get endpoint health');
      throw error;
    }
  }
}

export const runpodClient = new RunPodClient();
