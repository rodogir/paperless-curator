import { describe, expect, test } from "bun:test";
import { requestJson, type FetchLike, type RetryInfo } from "../src/http.ts";
import { jsonResponse } from "./helpers.ts";

const baseOptions = {
  source: "paperless" as const,
  url: "https://paperless.invalid/api/tags/",
  retry: { timeoutMs: 50, maxRetries: 0, retryBackoffMs: 1 },
};

describe("requestJson", () => {
  test("enforces a hard whole-request timeout", async () => {
    const hanging: FetchLike = () => new Promise<Response>(() => {});
    const startedAt = Date.now();
    await expect(
      requestJson({ ...baseOptions, fetchImpl: hanging }),
    ).rejects.toMatchObject({ category: "transient" });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("does not retry permanent HTTP failures", async () => {
    let calls = 0;
    const notFound: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ detail: "not found" }, 404);
    };
    await expect(
      requestJson({
        ...baseOptions,
        fetchImpl: notFound,
        retry: { ...baseOptions.retry, maxRetries: 3 },
      }),
    ).rejects.toMatchObject({ category: "permanent", status: 404 });
    expect(calls).toBe(1);
  });

  test("reports retry attempts", async () => {
    const retries: RetryInfo[] = [];
    let calls = 0;
    const flaky: FetchLike = async () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("connection refused");
      }
      return jsonResponse({ ok: true });
    };
    const result = await requestJson({
      ...baseOptions,
      fetchImpl: flaky,
      retry: { ...baseOptions.retry, maxRetries: 1 },
      onRetry: (info) => retries.push(info),
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.attempt).toBe(1);
    expect(retries[0]?.source).toBe("paperless");
  });

  test("rejects malformed JSON as permanent", async () => {
    const malformed: FetchLike = async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    await expect(
      requestJson({ ...baseOptions, fetchImpl: malformed }),
    ).rejects.toMatchObject({ category: "permanent" });
  });
});
