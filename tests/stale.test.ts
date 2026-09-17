import { describe, expect, test } from "bun:test";
import { createLogger, type Logger } from "../src/logger.ts";
import type { StateTagIds } from "../src/metadata.ts";
import type { PaperlessContext } from "../src/paperless.ts";
import {
  evaluateStaleProcessing,
  recoverStaleProcessing,
} from "../src/stale.ts";
import { jsonResponse } from "./helpers.ts";

const stateTagIds: StateTagIds = {
  pending: 70,
  processing: 71,
  processed: 72,
  review: 73,
  failed: 74,
};

const thresholdMs = 600_000;
const oldModified = "2026-01-01T00:00:00.000Z";
const oldMs = Date.parse(oldModified);

function silent(): Logger {
  return createLogger({ sink: () => {} });
}

describe("evaluateStaleProcessing", () => {
  const nowMs = oldMs + thresholdMs + 1_000;

  test("flags a processing-only document past the threshold", () => {
    expect(
      evaluateStaleProcessing(
        { id: 1, tags: [71], modified: oldModified },
        stateTagIds,
        thresholdMs,
        nowMs,
      ),
    ).toEqual({ stale: true, ageMs: thresholdMs + 1_000 });
  });

  test("does not flag a document without the processing tag", () => {
    expect(
      evaluateStaleProcessing(
        { id: 1, tags: [70], modified: oldModified },
        stateTagIds,
        thresholdMs,
        nowMs,
      ),
    ).toEqual({ stale: false, reason: "missing-processing-tag" });
  });

  test("does not flag conflicting state tags", () => {
    expect(
      evaluateStaleProcessing(
        { id: 1, tags: [71, 72], modified: oldModified },
        stateTagIds,
        thresholdMs,
        nowMs,
      ),
    ).toEqual({
      stale: false,
      reason: "conflicting-state-tags",
      conflicting: [72],
    });
  });

  test("does not flag an unparseable modified timestamp", () => {
    expect(
      evaluateStaleProcessing(
        { id: 1, tags: [71], modified: "" },
        stateTagIds,
        thresholdMs,
        nowMs,
      ),
    ).toEqual({ stale: false, reason: "unparseable-modified" });
  });

  test("does not flag a recently changed document", () => {
    const recent = new Date(nowMs - 1_000).toISOString();
    expect(
      evaluateStaleProcessing(
        { id: 1, tags: [71], modified: recent },
        stateTagIds,
        thresholdMs,
        nowMs,
      ),
    ).toEqual({ stale: false, reason: "not-yet-stale", ageMs: 1_000 });
  });
});

type FakeDoc = { id: number; tags: number[]; modified: string };

type Recorded = { method: string; path: string; body: unknown };

function makeServer(docs: FakeDoc[], failPatchIds: number[] = []) {
  const documents = docs.map((doc) => ({ ...doc, tags: [...doc.tags] }));
  const requests: Recorded[] = [];

  const detail = (doc: FakeDoc): unknown => ({
    id: doc.id,
    title: "",
    tags: doc.tags,
    correspondent: null,
    document_type: null,
    content: "",
    modified: doc.modified,
  });

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path: url.pathname, body });

    if (method === "PATCH") {
      const match = /^\/api\/documents\/(\d+)\/$/.exec(url.pathname);
      const id = Number(match?.[1]);
      if (failPatchIds.includes(id)) {
        return jsonResponse({ detail: "rejected" }, 400);
      }
      const doc = documents.find((entry) => entry.id === id);
      if (doc === undefined) {
        return new Response("not found", { status: 404 });
      }
      const patch = body as Partial<FakeDoc>;
      if (patch.tags !== undefined) {
        doc.tags = patch.tags;
      }
      return jsonResponse(detail(doc));
    }

    if (url.pathname === "/api/documents/") {
      const all = Number(url.searchParams.get("tags__id__all"));
      const results = documents
        .filter((doc) => doc.tags.includes(all))
        .sort((a, b) => a.id - b.id)
        .map((doc) => ({ id: doc.id, tags: doc.tags, modified: doc.modified }));
      return jsonResponse({
        count: results.length,
        next: null,
        previous: null,
        results,
      });
    }

    const match = /^\/api\/documents\/(\d+)\/$/.exec(url.pathname);
    if (match !== null) {
      const doc = documents.find((entry) => String(entry.id) === match[1]);
      return doc === undefined
        ? new Response("not found", { status: 404 })
        : jsonResponse(detail(doc));
    }
    return new Response("not found", { status: 404 });
  };

  return { documents, requests, fetchImpl };
}

function context(fetchImpl: PaperlessContext["fetchImpl"]): PaperlessContext {
  return {
    baseUrl: "https://paperless.invalid",
    token: "test-token",
    fetchImpl,
    retry: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
  };
}

function args(
  fake: ReturnType<typeof makeServer>,
  dryRun: boolean,
): Parameters<typeof recoverStaleProcessing>[0] {
  return {
    paperless: context(fake.fetchImpl),
    dryRun,
    stateTagIds,
    thresholdMs,
    nowMs: oldMs + thresholdMs + 1_000,
    log: silent(),
  };
}

describe("recoverStaleProcessing", () => {
  test("returns a stale document to pending while preserving non-state tags", async () => {
    const fake = makeServer([{ id: 34, tags: [71, 5], modified: oldModified }]);
    const outcomes = await recoverStaleProcessing(args(fake, false));

    expect(outcomes).toEqual([
      {
        documentId: 34,
        action: "recovered",
        ageMs: thresholdMs + 1_000,
      },
    ]);
    const patches = fake.requests.filter((entry) => entry.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ tags: [5, 70] });
    expect(fake.documents[0]?.tags).toEqual([5, 70]);
  });

  test("is idempotent: a second run finds nothing to recover", async () => {
    const fake = makeServer([{ id: 34, tags: [71, 5], modified: oldModified }]);
    await recoverStaleProcessing(args(fake, false));
    const second = await recoverStaleProcessing(args(fake, false));

    expect(second).toEqual([]);
    const patches = fake.requests.filter((entry) => entry.method === "PATCH");
    expect(patches).toHaveLength(1);
  });

  test("dry-run reports a would-recover and mutates nothing", async () => {
    const fake = makeServer([{ id: 34, tags: [71, 5], modified: oldModified }]);
    const outcomes = await recoverStaleProcessing(args(fake, true));

    expect(outcomes).toEqual([
      {
        documentId: 34,
        action: "would-recover",
        ageMs: thresholdMs + 1_000,
      },
    ]);
    expect(fake.requests.every((entry) => entry.method === "GET")).toBe(true);
    expect(fake.documents[0]?.tags).toEqual([71, 5]);
  });

  test("skips documents that are not yet stale", async () => {
    const recent = new Date(Date.now() - 1_000).toISOString();
    const fake = makeServer([{ id: 34, tags: [71], modified: recent }]);
    const outcomes = await recoverStaleProcessing(args(fake, false));

    expect(outcomes).toEqual([]);
    expect(fake.requests.filter((entry) => entry.method === "PATCH")).toEqual(
      [],
    );
  });

  test("skips conflicting state tags without repairing them", async () => {
    const lines: string[] = [];
    const fake = makeServer([
      { id: 34, tags: [71, 72], modified: oldModified },
    ]);
    const outcomes = await recoverStaleProcessing({
      ...args(fake, false),
      log: createLogger({ sink: (line) => lines.push(line) }),
    });

    expect(outcomes).toEqual([]);
    expect(fake.requests.filter((entry) => entry.method === "PATCH")).toEqual(
      [],
    );
    expect(
      lines.some((line) => line.includes("stale-processing-skipped")),
    ).toBe(true);
  });

  test("one failed recovery does not block the others", async () => {
    const fake = makeServer(
      [
        { id: 34, tags: [71], modified: oldModified },
        { id: 35, tags: [71, 9], modified: oldModified },
      ],
      [34],
    );
    const outcomes = await recoverStaleProcessing(args(fake, false));

    expect(outcomes.map((entry) => entry.action)).toEqual([
      "failed",
      "recovered",
    ]);
    expect(fake.documents[1]?.tags).toEqual([9, 70]);
  });
});
