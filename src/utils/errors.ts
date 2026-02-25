export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, code?: string) {
    super(400, message, code);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', code?: string) {
    super(401, message, code);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', code?: string) {
    super(403, message, code);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found', code?: string) {
    super(404, message, code);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  public readonly details: Record<string, unknown>;

  constructor(
    message: string,
    details: Record<string, unknown> = {},
    code?: string,
  ) {
    super(409, message, code);
    this.name = 'ConflictError';
    this.details = details;
  }
}

export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error', code?: string) {
    super(500, message, code);
    this.name = 'InternalServerError';
  }
}

/**
 * LLM service unavailable (API key missing, service down, etc.)
 */
export class LLMUnavailableError extends AppError {
  constructor(message: string = 'LLM service unavailable', code?: string) {
    super(503, message, code);
    this.name = 'LLMUnavailableError';
  }
}

/**
 * Failed to apply a diff to content.
 */
export class DiffApplicationError extends AppError {
  public readonly originalContent: string;
  public readonly diff: string;

  constructor(
    message: string,
    originalContent: string,
    diff: string,
    code?: string,
  ) {
    super(422, message, code);
    this.name = 'DiffApplicationError';
    this.originalContent = originalContent;
    this.diff = diff;
  }
}

/**
 * Entity not found in graph database.
 */
export class EntityNotFoundError extends NotFoundError {
  public readonly entityId: string;
  public readonly entityType?: string;

  constructor(entityId: string, entityType?: string, code?: string) {
    const message = entityType
      ? `${entityType} not found: ${entityId}`
      : `Entity not found: ${entityId}`;
    super(message, code);
    this.name = 'EntityNotFoundError';
    this.entityId = entityId;
    this.entityType = entityType;
  }
}

/**
 * Invalid LLM response format.
 */
export class LLMResponseError extends AppError {
  public readonly response: string;

  constructor(message: string, response: string, code?: string) {
    super(422, message, code);
    this.name = 'LLMResponseError';
    this.response = response;
  }
}
