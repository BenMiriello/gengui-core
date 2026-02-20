/**
 * Custom error classes for pipeline interruption handling.
 */

export class AnalysisCancelledError extends Error {
  constructor(message = 'Analysis cancelled') {
    super(message);
    this.name = 'AnalysisCancelledError';
  }
}

export class AnalysisPausedError extends Error {
  constructor(message = 'Analysis paused') {
    super(message);
    this.name = 'AnalysisPausedError';
  }
}
