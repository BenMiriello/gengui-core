/**
 * Adaptive batch calibration for output token estimation.
 *
 * Learns from actual batch results to improve estimation accuracy.
 * Starts VERY conservative (1.5x multiplier) and backs off DRAMATICALLY
 * when MAX_TOKENS errors occur.
 */

import { logger } from '../../utils/logger';
import { estimateExtractionOutputTokens } from './operationConfigs';

export interface CalibrationMetrics {
  batchId: string;
  timestamp: number;
  totalInputChars: number;
  estimatedEntities: number;
  estimatedOutputTokens: number;
  actualOutputTokens: number;
  actualEntities: number;
  actualFacets: number;
  actualMentions: number;
  hitMaxTokens: boolean;
}

export class BatchCalibrator {
  private history: CalibrationMetrics[] = [];
  private maxHistory = 50;
  private recencyWeight = 0.7;

  private conservativeMultiplier = 1.5;

  recordBatch(metrics: CalibrationMetrics): void {
    this.history.push(metrics);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    if (metrics.hitMaxTokens) {
      const oldMultiplier = this.conservativeMultiplier;
      this.conservativeMultiplier = Math.max(
        this.conservativeMultiplier * 1.5,
        2.0,
      );

      logger.error(
        {
          previousMultiplier: oldMultiplier,
          newMultiplier: this.conservativeMultiplier,
          recentBatches: this.history.slice(-5).map((b) => ({
            estimated: b.estimatedOutputTokens,
            actual: b.actualOutputTokens,
            ratio: (b.actualOutputTokens / b.estimatedOutputTokens).toFixed(2),
          })),
        },
        'MAX_TOKENS HIT - BACKING OFF DRAMATICALLY',
      );

      return;
    }

    if (this.history.length >= 20) {
      const recent = this.history.slice(-20);
      const allUnderBudget = recent.every(
        (b) =>
          !b.hitMaxTokens &&
          b.actualOutputTokens < b.estimatedOutputTokens * 0.8,
      );

      if (allUnderBudget && this.conservativeMultiplier > 1.0) {
        const oldMultiplier = this.conservativeMultiplier;
        this.conservativeMultiplier = Math.max(
          this.conservativeMultiplier * 0.95,
          1.0,
        );

        logger.info(
          {
            oldMultiplier,
            newMultiplier: this.conservativeMultiplier,
            reason: '20 consecutive batches under 80% budget',
          },
          'Easing conservative multiplier',
        );
      }
    }
  }

  hasEnoughData(): boolean {
    return this.history.length >= 10;
  }

  getAdjustedEstimate(totalInputChars: number): number {
    if (!this.hasEnoughData()) {
      return (
        this.formulaBasedEstimate(totalInputChars) * this.conservativeMultiplier
      );
    }

    const charsPerToken = 3.3;
    const recentBatches = this.history
      .slice(-20)
      .filter((b) => !b.hitMaxTokens && b.actualOutputTokens > 0);

    if (recentBatches.length === 0) {
      return (
        this.formulaBasedEstimate(totalInputChars) * this.conservativeMultiplier
      );
    }

    const actualRatios = recentBatches.map(
      (b) => b.actualOutputTokens / (b.totalInputChars / charsPerToken),
    );
    const weightedRatio = this.calculateWeightedAverage(actualRatios);

    const inputTokens = totalInputChars / charsPerToken;
    return Math.ceil(inputTokens * weightedRatio * this.conservativeMultiplier);
  }

  private calculateWeightedAverage(values: number[]): number {
    if (values.length === 0) return 0;

    const weights = values.map(
      (_, i) => this.recencyWeight ** (values.length - i - 1),
    );
    const weightSum = weights.reduce((a, b) => a + b, 0);

    return (
      values.reduce((sum, val, i) => sum + val * weights[i], 0) / weightSum
    );
  }

  private formulaBasedEstimate(totalInputChars: number): number {
    return estimateExtractionOutputTokens(totalInputChars, false);
  }

  getMetrics() {
    return {
      historySize: this.history.length,
      conservativeMultiplier: this.conservativeMultiplier,
      recentAccuracy: this.history.slice(-10).map((b) => ({
        estimated: b.estimatedOutputTokens,
        actual: b.actualOutputTokens,
        ratio: (b.actualOutputTokens / b.estimatedOutputTokens).toFixed(2),
      })),
    };
  }
}

export const batchCalibrator = new BatchCalibrator();
