/**
 * Multi-stage extraction pipeline.
 * Orchestrates the 7-stage entity extraction process.
 */

export { multiStagePipeline, type PipelineOptions, type PipelineResult } from './pipeline';
export { type AnalysisStage, STAGE_LABELS } from './stages';
export {
  type AnalysisCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  shouldRunStage,
  isCheckpointValid,
} from './checkpoint';
export { AnalysisCancelledError, AnalysisPausedError } from './errors';
