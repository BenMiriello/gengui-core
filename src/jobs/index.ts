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
} from './types';
export { JobCancelledError, JobPausedError } from './types';
export { JobWorker } from './worker';

// Workers
export { documentAnalysisWorker } from './workers/document-analysis';
export { mediaStatusWorker } from './workers/media-status';
export { pdfExportWorker } from './workers/pdf-export';
export { promptAugmentationWorker } from './workers/prompt-augmentation';
export { thumbnailWorker } from './workers/thumbnail';

/**
 * Start all job workers.
 * Call this from index.ts after server starts.
 */
export async function startJobWorkers(): Promise<void> {
  const { documentAnalysisWorker } = await import(
    './workers/document-analysis.js'
  );
  const { promptAugmentationWorker } = await import(
    './workers/prompt-augmentation.js'
  );
  const { mediaStatusWorker } = await import('./workers/media-status.js');
  const { pdfExportWorker } = await import('./workers/pdf-export.js');
  const { thumbnailWorker } = await import('./workers/thumbnail.js');

  await Promise.all([
    documentAnalysisWorker.start(),
    promptAugmentationWorker.start(),
    mediaStatusWorker.start(),
    pdfExportWorker.start(),
    thumbnailWorker.start(),
  ]);
}

/**
 * Stop all job workers gracefully.
 * Call this during shutdown.
 */
export async function stopJobWorkers(): Promise<void> {
  const { documentAnalysisWorker } = await import(
    './workers/document-analysis.js'
  );
  const { promptAugmentationWorker } = await import(
    './workers/prompt-augmentation.js'
  );
  const { mediaStatusWorker } = await import('./workers/media-status.js');
  const { pdfExportWorker } = await import('./workers/pdf-export.js');
  const { thumbnailWorker } = await import('./workers/thumbnail.js');

  await Promise.all([
    documentAnalysisWorker.stop(),
    promptAugmentationWorker.stop(),
    mediaStatusWorker.stop(),
    pdfExportWorker.stop(),
    thumbnailWorker.stop(),
  ]);
}
