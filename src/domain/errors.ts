export class Neo4jError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'Neo4jError';
    this.cause = cause;
  }
}

export class EmbeddingError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EmbeddingError';
    this.cause = cause;
  }
}

export class VectorQueryError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VectorQueryError';
    this.cause = cause;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

export interface ToolErrorPayload {
  isError: true;
  errorType: string;
  message: string;
}

export function toToolError(e: unknown): ToolErrorPayload {
  if (e instanceof Error) {
    return { isError: true, errorType: e.name, message: e.message };
  }
  return { isError: true, errorType: 'UnknownError', message: String(e) };
}
