// Constants for job configuration
export const RUNPOD_CONSTANTS = {
  // Job execution timeout for zit-basic model (3-8s typical + 12s buffer)
  EXECUTION_TIMEOUT_MS: 20000,

  // Redis TTL for RunPod job mappings (1 hour)
  REDIS_JOB_TTL_SECONDS: 3600,

  // Reconciliation polling interval (5 seconds)
  RECONCILIATION_INTERVAL_MS: 5000,

  // Staleness threshold for stuck job detection (20s timeout + 2s buffer)
  STALENESS_THRESHOLD_MS: 22000,

  // Maximum retry attempts before permanent failure
  MAX_ATTEMPTS: 3,
} as const;
