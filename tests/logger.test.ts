import { describe, expect, test } from "bun:test";
import { createLogger, withRateLimit } from "../src/logger.ts";

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("createLogger", () => {
  test("emits single-line JSON and omits undefined fields", () => {
    const { lines, sink } = capture();
    const log = createLogger({ sink, now: () => "2026-01-01T00:00:00.000Z" });
    log("info", "cycle-complete", { documentId: 34, skip: undefined });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(record).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      event: "cycle-complete",
      documentId: 34,
    });
  });
});

describe("withRateLimit", () => {
  test("drops repeated events within the window and passes distinct ones", () => {
    const { lines, sink } = capture();
    let nowMs = 0;
    const log = withRateLimit(createLogger({ sink }), 1_000, () => nowMs);

    log("error", "refresh-failed", { message: "one" });
    log("error", "refresh-failed", { message: "two" });
    log("warn", "other-event", {});
    nowMs = 500;
    log("error", "refresh-failed", { message: "three" });
    nowMs = 1_500;
    log("error", "refresh-failed", { message: "four" });

    const records = lines.map(
      (line) => JSON.parse(line) as { event: string; message?: string },
    );
    expect(records.map((record) => record.event)).toEqual([
      "refresh-failed",
      "other-event",
      "refresh-failed",
    ]);
    expect(records[0]?.message).toBe("one");
    expect(records[2]?.message).toBe("four");
  });
});
