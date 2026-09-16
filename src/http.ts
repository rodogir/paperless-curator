import {
  classifyStatus,
  UpstreamError,
  type UpstreamSource,
} from "./errors.ts";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type RetryPolicy = {
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
};

export type RetryInfo = {
  source: UpstreamSource;
  attempt: number;
  delayMs: number;
  reason: string;
};

export type RequestOptions = {
  source: UpstreamSource;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  fetchImpl: FetchLike;
  retry: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function backoffDelay(attempt: number, baseMs: number): number {
  return baseMs * 2 ** attempt;
}

function toUpstreamError(
  error: unknown,
  source: UpstreamSource,
  timeoutMs: number,
): UpstreamError {
  if (error instanceof UpstreamError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new UpstreamError(`request timed out after ${timeoutMs}ms`, {
      category: "transient",
      source,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new UpstreamError(`request aborted after ${timeoutMs}ms`, {
      category: "transient",
      source,
      cause: error,
    });
  }
  return new UpstreamError("network request failed", {
    category: "transient",
    source,
    cause: error,
  });
}

/**
 * Performs a single HTTP request with a hard, whole-operation timeout. The
 * timeout also covers reading the response body, which `AbortSignal.timeout`
 * alone does not reliably bound on every runtime. The response body is parsed
 * as JSON; bodies are never included in errors.
 */
async function performRequest(
  source: UpstreamSource,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = new UpstreamError(
    `request timed out after ${timeoutMs}ms`,
    { category: "transient", source },
  );

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });

  const work = (async (): Promise<unknown> => {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new UpstreamError(`upstream returned HTTP ${response.status}`, {
        category: classifyStatus(response.status),
        source,
        status: response.status,
      });
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new UpstreamError("upstream returned malformed JSON", {
        category: "permanent",
        source,
        status: response.status,
        cause: error,
      });
    }
  })();

  // Prevent an unhandled rejection if the timeout wins the race.
  work.catch(() => {});

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Performs an HTTP request and parses the response as JSON.
 *
 * Retries only transient failures (timeouts, connection errors, retryable
 * status codes). Permanent failures such as 4xx responses are thrown
 * immediately. Response bodies are never included in error messages, so
 * document content and OCR text cannot leak into logs.
 */
export async function requestJson(options: RequestOptions): Promise<unknown> {
  const {
    source,
    url,
    method = "GET",
    headers = {},
    body,
    fetchImpl,
    retry,
    sleep: sleepImpl = sleep,
    onRetry,
  } = options;

  const attempts = Math.max(1, retry.maxRetries + 1);
  let lastError: UpstreamError | undefined;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      const delayMs = backoffDelay(attempt - 1, retry.retryBackoffMs);
      onRetry?.({
        source,
        attempt,
        delayMs,
        reason: lastError?.message ?? "transient failure",
      });
      await sleepImpl(delayMs);
    }

    try {
      return await performRequest(
        source,
        url,
        method,
        headers,
        body,
        fetchImpl,
        retry.timeoutMs,
      );
    } catch (error) {
      const normalized = toUpstreamError(error, source, retry.timeoutMs);
      lastError = normalized;
      if (normalized.category === "permanent") {
        throw normalized;
      }
    }
  }

  throw (
    lastError ??
    new UpstreamError("request failed", { category: "transient", source })
  );
}
