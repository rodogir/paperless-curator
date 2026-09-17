import { describe, expect, test } from "bun:test";
import { abortableSleep, serviceBackoffDelay } from "../src/runner.ts";

describe("serviceBackoffDelay", () => {
  test("doubles the initial delay and caps it", () => {
    expect(serviceBackoffDelay(0, 1_000, 60_000)).toBe(1_000);
    expect(serviceBackoffDelay(1, 1_000, 60_000)).toBe(2_000);
    expect(serviceBackoffDelay(2, 1_000, 60_000)).toBe(4_000);
    expect(serviceBackoffDelay(6, 1_000, 60_000)).toBe(60_000);
    expect(serviceBackoffDelay(100, 1_000, 60_000)).toBe(60_000);
  });

  test("never returns a negative delay", () => {
    expect(serviceBackoffDelay(-5, 500, 60_000)).toBe(500);
  });
});

describe("abortableSleep", () => {
  test("resolves early when aborted", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = abortableSleep(5_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("resolves immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    await abortableSleep(5_000, controller.signal);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });
});
