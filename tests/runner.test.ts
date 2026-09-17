import { describe, expect, test } from "bun:test";
import {
  type AppConfig,
  DEFAULT_OPERATIONS,
  DEFAULT_STATE_TAGS,
} from "../src/config.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import type { StateTagIds } from "../src/metadata.ts";
import {
  runWorkerLoop,
  type SleepFn,
  type WorkerState,
} from "../src/runner.ts";
import type { Whitelist } from "../src/whitelist.ts";
import type { CycleResult } from "../src/worker.ts";

const stateTagIds: StateTagIds = {
  pending: 70,
  processing: 71,
  processed: 72,
  review: 73,
  failed: 74,
};

const emptyWhitelist: Whitelist = {
  version: 1,
  tags: [],
  correspondents: [],
  documentTypes: [],
};

function workerState(): WorkerState {
  return {
    whitelist: emptyWhitelist,
    vocab: { tags: [], correspondents: [], documentTypes: [] },
    stateTagIds,
  };
}

function config(overrides: Partial<AppConfig["operations"]> = {}): AppConfig {
  return {
    version: 1,
    paperless: { baseUrl: "https://paperless.invalid" },
    llm: { baseUrl: "https://llm.invalid/v1", model: "test-model" },
    stateTags: DEFAULT_STATE_TAGS,
    dryRun: true,
    overwrite: { title: false, correspondent: false, documentType: false },
    limits: { maxTitleLength: 128, maxOcrChars: 30000 },
    request: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
    operations: {
      ...DEFAULT_OPERATIONS,
      pollIntervalMs: 100,
      vocabularyRefreshMs: 100_000,
      backoff: { initialMs: 10, maxMs: 40 },
      ...overrides,
    },
    dataDir: "/tmp/opencode/unused",
  };
}

function cycleResult(
  outcome: CycleResult["outcome"] = "no-candidate",
): CycleResult {
  return {
    outcome,
    documentId: null,
    decision: null,
    classification: null,
    created: [],
    requeues: [],
    staleRecoveries: [],
  };
}

function silent(): Logger {
  return createLogger({ sink: () => {} });
}

describe("runWorkerLoop", () => {
  test("runs one cycle at a time and sleeps the poll interval between cycles", async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;

    const result = await runWorkerLoop({
      config: config(),
      log: silent(),
      initial: workerState(),
      refresh: async () => {
        throw new Error("unexpected refresh");
      },
      cycle: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push("cycle-start");
        await Promise.resolve();
        order.push("cycle-end");
        active -= 1;
        return cycleResult();
      },
      maxCycles: 3,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    expect(result.cycles).toBe(3);
    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "cycle-start",
      "cycle-end",
      "cycle-start",
      "cycle-end",
      "cycle-start",
      "cycle-end",
    ]);
    // No sleep after the final cycle when a cycle limit is set.
    expect(sleeps).toEqual([100, 100]);
  });

  test("applies capped exponential backoff when a cycle fails", async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const controller = new AbortController();
    const sleep: SleepFn = async (ms) => {
      sleeps.push(ms);
      nowMs += ms;
      if (sleeps.length >= 6) {
        controller.abort();
      }
    };

    const result = await runWorkerLoop({
      config: config(),
      log: silent(),
      initial: workerState(),
      refresh: async () => workerState(),
      cycle: async () => {
        throw new Error("paperless unavailable");
      },
      now: () => nowMs,
      sleep,
      signal: controller.signal,
    });

    expect(result.cycles).toBe(0);
    expect(sleeps).toEqual([10, 20, 40, 40, 40, 40]);
  });

  test("blocks processing when refresh fails and rate-limits the log", async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const controller = new AbortController();
    const lines: string[] = [];
    let refreshCalls = 0;
    let cycleCalls = 0;

    const result = await runWorkerLoop({
      config: config(),
      log: createLogger({ sink: (line) => lines.push(line) }),
      initial: null,
      refresh: async () => {
        refreshCalls += 1;
        throw new Error("paperless unavailable");
      },
      cycle: async () => {
        cycleCalls += 1;
        return cycleResult();
      },
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
        if (sleeps.length >= 3) {
          controller.abort();
        }
      },
      signal: controller.signal,
    });

    expect(result.cycles).toBe(0);
    expect(cycleCalls).toBe(0);
    expect(refreshCalls).toBe(3);
    expect(sleeps).toEqual([10, 20, 40]);
    const failures = lines
      .map((line) => JSON.parse(line) as { event: string })
      .filter((record) => record.event === "refresh-failed");
    expect(failures).toHaveLength(1);
  });

  test("refreshes on the configured interval and uses the new state", async () => {
    let nowMs = 0;
    let refreshCalls = 0;
    const seen: WorkerState[] = [];
    const refreshed = workerState();
    refreshed.vocab = {
      tags: [{ id: 1, name: "Fresh" }],
      correspondents: [],
      documentTypes: [],
    };

    const result = await runWorkerLoop({
      config: config({ vocabularyRefreshMs: 250, pollIntervalMs: 100 }),
      log: silent(),
      initial: workerState(),
      refresh: async () => {
        refreshCalls += 1;
        return refreshed;
      },
      cycle: async (state) => {
        seen.push(state);
        return cycleResult();
      },
      maxCycles: 4,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });

    expect(result.cycles).toBe(4);
    expect(refreshCalls).toBe(1);
    expect(seen[0]).not.toBe(refreshed);
    expect(seen[3]).toBe(refreshed);
  });

  test("re-lists vocabularies after creating a whitelist entity", async () => {
    let refreshCalls = 0;
    const created: CycleResult = {
      ...cycleResult("updated"),
      created: [{ kind: "tag", name: "New", action: "created", id: 9 }],
    };

    await runWorkerLoop({
      config: config(),
      log: silent(),
      initial: workerState(),
      refresh: async () => {
        refreshCalls += 1;
        return workerState();
      },
      cycle: async () => created,
      maxCycles: 1,
      now: () => 0,
      sleep: async () => {},
    });

    expect(refreshCalls).toBe(1);
  });

  test("gracefully stops after the active cycle and interrupts the poll sleep", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let cyclesRun = 0;

    const result = await runWorkerLoop({
      config: config(),
      log: silent(),
      initial: workerState(),
      refresh: async () => workerState(),
      cycle: async () => {
        cyclesRun += 1;
        return cycleResult();
      },
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
      signal: controller.signal,
    });

    expect(cyclesRun).toBe(1);
    expect(sleeps).toEqual([100]);
    expect(result).toEqual({
      reason: "stopped",
      cycles: 1,
      lastOutcome: "no-candidate",
    });
  });

  test("does not sleep or start another cycle when aborted mid-cycle", async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let cyclesRun = 0;

    const result = await runWorkerLoop({
      config: config(),
      log: silent(),
      initial: workerState(),
      refresh: async () => workerState(),
      cycle: async () => {
        cyclesRun += 1;
        controller.abort();
        return cycleResult("updated");
      },
      now: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      signal: controller.signal,
    });

    expect(cyclesRun).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result.lastOutcome).toBe("updated");
  });

  test("refreshes before the first cycle when initial state is null", async () => {
    const order: string[] = [];

    await runWorkerLoop({
      config: config(),
      log: silent(),
      initial: null,
      refresh: async () => {
        order.push("refresh");
        return workerState();
      },
      cycle: async () => {
        order.push("cycle");
        return cycleResult();
      },
      maxCycles: 1,
      now: () => 0,
      sleep: async () => {},
    });

    expect(order).toEqual(["refresh", "cycle"]);
  });
});
