/**
 * Reusable batch processing utilities for pipeline stages.
 */

import type { BatchBudgetResult } from '../contextBudget';
import type { AnalysisStage } from './stages';

/**
 * Process batches in parallel for relationship extraction.
 * Reusable pattern for both intra-segment and cross-segment relationship stages.
 */
export async function processBatchesInParallel<
  TBatchInput,
  TExtractResult extends { relationships: any[] },
>(
  batches: BatchBudgetResult<TBatchInput>[],
  extractFn: (items: TBatchInput[]) => Promise<TExtractResult>,
  broadcast: (stage: AnalysisStage, entityCount?: number, statusHint?: string) => void,
  stageNumber: AnalysisStage,
  totalCount: number,
): Promise<TExtractResult['relationships']> {
  const allBatchResults = await Promise.all(
    batches.map(async (batch, batchIdx) => {
      broadcast(
        stageNumber + 1 as AnalysisStage,
        totalCount,
        `Processing batch ${batchIdx + 1}/${batches.length}...`,
      );
      return extractFn(batch.includedItems);
    }),
  );

  const allRelationships: TExtractResult['relationships'] = [];
  for (const batchResult of allBatchResults) {
    allRelationships.push(...batchResult.relationships);
  }

  return allRelationships;
}
