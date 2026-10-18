/** Raised when the prompt exceeds the model's context window. */
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

/**
 * Raised when HTTP 429 persists after rotating through every key and exhausting
 * the backoff budget. The pipeline reacts by pausing and keeping its checkpoint.
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfter?: number,
    readonly provider?: string,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}
