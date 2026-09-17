export type ErrorCategory = "transient" | "permanent";

export type UpstreamSource = "paperless" | "llm";

export class UpstreamError extends Error {
  readonly category: ErrorCategory;
  readonly source: UpstreamSource;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: {
      category: ErrorCategory;
      source: UpstreamSource;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "UpstreamError";
    this.category = options.category;
    this.source = options.source;
    this.status = options.status;
  }
}

export function isUpstreamError(value: unknown): value is UpstreamError {
  return value instanceof UpstreamError;
}

export function classifyStatus(status: number): ErrorCategory {
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return "transient";
  }
  return "permanent";
}

/**
 * Categories for structured logs. `unknown` means the error did not come from
 * a validated upstream boundary (for example a local programming error) and is
 * therefore not safe to retry indefinitely.
 */
export type LoggedErrorCategory = ErrorCategory | "unknown";

export function errorCategory(error: unknown): LoggedErrorCategory {
  return isUpstreamError(error) ? error.category : "unknown";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
