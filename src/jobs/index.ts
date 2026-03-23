/**
 * Job processing system entry point.
 * Exports all job-related modules and initializes workers.
 */

export { jobService } from './service';
export type {
  AnalysisCheckpoint,
  AnalysisProgress,
  CreateJobParams,
  Job,
  JobProgress,
  JobStatus,
  JobType,
  TargetType,
  VersionUpgradeCheckpoint,
  VersionUpgradeProgress,
} from './types';
export { JobCancelledError, JobPausedError } from './types';
export { JobWorker } from './worker';

// Workers
export { analysisVersionUpgradeWorker } from './workers/analysis-version-upgrade';
export { documentAnalysisWorker } from './workers/document-analysis';
export { imageGenerationWorker } from './workers/image-generation';
export { mediaStatusWorker } from './workers/media-status';
export { promptAugmentationWorker } from './workers/prompt-augmentation';
export { thumbnailWorker } from './workers/thumbnail';

/**
 * Start all job workers.
 * Call this from index.ts after server starts.
 */
export async function startJobWorkers(): Promise<void> {
  const { analysisVersionUpgradeWorker } = await import(
    './workers/analysis-version-upgrade.js'
  );
  const { documentAnalysisWorker } = await import(
    './workers/document-analysis.js'
  );
  const { imageGenerationWorker } = await import(
    './workers/image-generation.js'
  );
  const { promptAugmentationWorker } = await import(
    './workers/prompt-augmentation.js'
  );
  const { mediaStatusWorker } = await import('./workers/media-status.js');
  const { thumbnailWorker } = await import('./workers/thumbnail.js');
  const { activityService } = await import('../services/activity.service.js');

  // Sync any orphaned activities from previous runs
  await activityService.syncOrphanedActivities();

  await Promise.all([
    analysisVersionUpgradeWorker.start(),
    documentAnalysisWorker.start(),
    imageGenerationWorker.start(),
    promptAugmentationWorker.start(),
    mediaStatusWorker.start(),
    thumbnailWorker.start(),
  ]);
}

/**
 * Stop all job workers gracefully.
 * Call this during shutdown.
 */
export async function stopJobWorkers(): Promise<void> {
  const { analysisVersionUpgradeWorker } = await import(
    './workers/analysis-version-upgrade.js'
  );
  const { documentAnalysisWorker } = await import(
    './workers/document-analysis.js'
  );
  const { imageGenerationWorker } = await import(
    './workers/image-generation.js'
  );
  const { promptAugmentationWorker } = await import(
    './workers/prompt-augmentation.js'
  );
  const { mediaStatusWorker } = await import('./workers/media-status.js');
  const { thumbnailWorker } = await import('./workers/thumbnail.js');

  await Promise.all([
    analysisVersionUpgradeWorker.stop(),
    documentAnalysisWorker.stop(),
    imageGenerationWorker.stop(),
    promptAugmentationWorker.stop(),
    mediaStatusWorker.stop(),
    thumbnailWorker.stop(),
  ]);
}
