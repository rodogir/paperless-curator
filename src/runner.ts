import type { AppConfig } from "./config.ts";
import type { Vocabularies } from "./decision.ts";
import { errorCategory, errorMessage } from "./errors.ts";
import { type Logger, withRateLimit } from "./logger.ts";
import type { StateTagIds } from "./metadata.ts";
import type { Whitelist } from "./whitelist.ts";
import type { CycleResult } from "./worker.ts";

/** Mutable state refreshed periodically and consumed by each cycle. */
export type WorkerState = {
  whitelist: Whitelist;
  vocab: Vocabularies;
  stateTagIds: StateTagIds;
};

/** Sleep that can be interrupted by a shutdown signal. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * Real sleep used by the worker loop. Resolves early when `signal` aborts so a
 * SIGINT/SIGTERM is not delayed by the full poll interval.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Service-connectivity backoff: exponential from `initialMs`, hard-capped at
 * `maxMs`. This is separate from the bounded per-request retries in http.ts and
 * may repeat indefinitely.
 */
export function serviceBackoffDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 30));
  return Math.min(initialMs * 2 ** safeAttempt, maxMs);
}

export type CycleMeta = {
  cycle: number;
  durationMs: number;
};

export type WorkerLoopDeps = {
  config: AppConfig;
  log: Logger;
  /**
   * Worker state. `null` forces a refresh before the first cycle, so a worker
   * that starts while Paperless is unavailable stays alive and retries.
   */
  initial: WorkerState | null;
  /** Re-reads the whitelist and re-lists Paperless vocabularies. */
  refresh: () => Promise<WorkerState>;
  /** Runs exactly one document cycle against the supplied state. */
  cycle: (state: WorkerState) => Promise<CycleResult>;
  onCycleComplete?: (result: CycleResult, meta: CycleMeta) => void;
  /** Stops after this many completed cycles. Used for `--once`. */
  maxCycles?: number;
  now?: () => number;
  sleep?: SleepFn;
  signal?: AbortSignal;
};

export type WorkerLoopResult = {
  reason: "stopped";
  cycles: number;
  lastOutcome: CycleResult["outcome"] | null;
};

/**
 * Runs one guarded document cycle at a time, sleeping between cycles. The loop
 * never overlaps cycles (`cycle` is awaited), always sleeps before starting the
 * next one, and retries service-level failures indefinitely with capped
 * backoff. A refresh failure blocks processing rather than crashing.
 */
export async function runWorkerLoop(
  deps: WorkerLoopDeps,
): Promise<WorkerLoopResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? abortableSleep;
  const signal = deps.signal;
  const { operations } = deps.config;
  const statusLog = withRateLimit(deps.log, 60_000, now);

  let state = deps.initial;
  let pendingRefresh = state === null;
  let lastRefreshAt = now();
  let serviceFailures = 0;
  let cycles = 0;
  let lastOutcome: CycleResult["outcome"] | null = null;

  const stopped = (): boolean => signal?.aborted === true;
  const reachedCycleLimit = (): boolean =>
    deps.maxCycles !== undefined && cycles >= deps.maxCycles;

  while (!stopped() && !reachedCycleLimit()) {
    if (
      pendingRefresh ||
      now() - lastRefreshAt >= operations.vocabularyRefreshMs
    ) {
      try {
        state = await deps.refresh();
        pendingRefresh = false;
        lastRefreshAt = now();
        serviceFailures = 0;
        deps.log("info", "refresh-complete", {
          tagCount: state.vocab.tags.length,
          correspondentCount: state.vocab.correspondents.length,
          documentTypeCount: state.vocab.documentTypes.length,
        });
      } catch (error) {
        const delayMs = serviceBackoffDelay(
          serviceFailures,
          operations.backoff.initialMs,
          operations.backoff.maxMs,
        );
        statusLog("error", "refresh-failed", {
          attempt: serviceFailures,
          delayMs,
          errorCategory: errorCategory(error),
          message: errorMessage(error),
          action: "processing is blocked until refresh succeeds",
        });
        serviceFailures += 1;
        await sleep(delayMs, signal);
        continue;
      }
    }

    if (state === null) {
      // Unreachable: a failed refresh continues above, so state is set here.
      await sleep(operations.backoff.initialMs, signal);
      continue;
    }

    const startedAt = now();
    let result: CycleResult;
    try {
      result = await deps.cycle(state);
    } catch (error) {
      const delayMs = serviceBackoffDelay(
        serviceFailures,
        operations.backoff.initialMs,
        operations.backoff.maxMs,
      );
      statusLog("error", "cycle-failed", {
        attempt: serviceFailures,
        delayMs,
        errorCategory: errorCategory(error),
        message: errorMessage(error),
      });
      serviceFailures += 1;
      await sleep(delayMs, signal);
      continue;
    }

    serviceFailures = 0;
    cycles += 1;
    lastOutcome = result.outcome;
    deps.onCycleComplete?.(result, {
      cycle: cycles,
      durationMs: now() - startedAt,
    });

    // Reconciliation may have created whitelist entities. Re-list immediately
    // so the next cycle sees them instead of re-planning the same creations.
    if (
      !stopped() &&
      result.created.some((entry) => entry.action === "created")
    ) {
      try {
        state = await deps.refresh();
        lastRefreshAt = now();
      } catch (error) {
        deps.log("warn", "post-create-refresh-failed", {
          errorCategory: errorCategory(error),
          message: errorMessage(error),
          action: "continuing; the periodic refresh will retry",
        });
      }
    }

    if (stopped() || reachedCycleLimit()) {
      break;
    }
    await sleep(operations.pollIntervalMs, signal);
  }

  deps.log("info", "worker-stopped", {
    reason: "shutdown",
    cycles,
    lastOutcome,
  });
  return { reason: "stopped", cycles, lastOutcome };
}
