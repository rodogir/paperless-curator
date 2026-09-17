import { describe, expect, test } from "bun:test";
import { type AppConfig, DEFAULT_STATE_TAGS } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import type { StateTagIds } from "../src/metadata.ts";
import { type ProcessDeps, processOneDocument } from "../src/process.ts";
import { jsonResponse, loadFixture } from "./helpers.ts";

const stateTagIds: StateTagIds = {
  pending: 70,
  processing: 71,
  processed: 72,
  review: 73,
  failed: 74,
};

const fixtures = {
  tags1: await loadFixture("paperless/tags-page-1.json"),
  tags2: await loadFixture("paperless/tags-page-2.json"),
  correspondents: await loadFixture("paperless/correspondents-page.json"),
  documentTypes: await loadFixture("paperless/document-types-page.json"),
  documents: await loadFixture("paperless/documents-pending.json"),
  detail: await loadFixture("paperless/document-detail.json"),
  llm: await loadFixture("llm/proposal-v2-valid.json"),
};

const config: AppConfig = {
  version: 1,
  paperless: { baseUrl: "https://paperless.invalid" },
  llm: { baseUrl: "https://llm.invalid/v1", model: "test-model" },
  stateTags: DEFAULT_STATE_TAGS,
  dryRun: true,
  overwrite: { title: false, correspondent: false, documentType: false },
  limits: { maxTitleLength: 128, maxOcrChars: 30000 },
  request: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
  dataDir: "./data",
};

describe("dry-run processing", () => {
  test("processes one eligible document using only Paperless GET requests", async () => {
    const requests: { method: string; url: string }[] = [];

    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({ method, url: url.toString() });

      if (url.hostname === "paperless.invalid" && method !== "GET") {
        throw new Error(
          `unexpected Paperless mutation: ${method} ${url.pathname}`,
        );
      }

      if (url.hostname === "llm.invalid") {
        return jsonResponse(fixtures.llm);
      }

      const path = url.pathname;
      if (path === "/api/tags/") {
        return url.searchParams.get("page") === "2"
          ? jsonResponse(fixtures.tags2)
          : jsonResponse(fixtures.tags1);
      }
      if (path === "/api/correspondents/")
        return jsonResponse(fixtures.correspondents);
      if (path === "/api/document_types/")
        return jsonResponse(fixtures.documentTypes);
      if (path === "/api/documents/") return jsonResponse(fixtures.documents);
      if (/^\/api\/documents\/\d+\/$/.test(path))
        return jsonResponse(fixtures.detail);
      return new Response("not found", { status: 404 });
    };

    const deps: ProcessDeps = {
      config,
      paperless: {
        baseUrl: config.paperless.baseUrl,
        token: "test-token",
        fetchImpl,
        retry: config.request,
      },
      llm: {
        baseUrl: config.llm.baseUrl,
        apiKey: "test-key",
        model: config.llm.model,
        fetchImpl,
        retry: config.request,
      },
      vocab: {
        tags: [
          { id: 70, name: "ai-pending" },
          { id: 5, name: "Example Tag" },
        ],
        correspondents: [{ id: 5, name: "Example Correspondent" }],
        documentTypes: [{ id: 18, name: "Example Type" }],
      },
      whitelist: {
        version: 1,
        tags: [{ name: "Example Tag", aliases: [], description: null }],
        correspondents: [
          { name: "Example Correspondent", aliases: [], description: null },
        ],
        documentTypes: [
          { name: "Example Type", aliases: [], description: null },
        ],
      },
      stateTagIds,
      log: createLogger({ sink: () => {} }),
    };

    const outcome = await processOneDocument(deps);

    expect(outcome.kind).toBe("classified");
    if (outcome.kind !== "classified") {
      throw new Error("expected a classified outcome");
    }
    expect(outcome.documentId).toBe(123);
    expect(outcome.decision.outcome).toBe("update");
    // The fixture document already has a title and overwrite is disabled.
    expect(outcome.decision.changes.title).toBeNull();
    expect(outcome.proposal?.title).toBe("Example Statement January 2026");
    expect(outcome.decision.changes.addTagIds).toEqual([5]);
    expect(outcome.ocr?.truncated).toBe(false);

    const paperlessRequests = requests.filter(
      (request) => new URL(request.url).hostname === "paperless.invalid",
    );
    expect(paperlessRequests.length).toBeGreaterThan(0);
    expect(paperlessRequests.every((request) => request.method === "GET")).toBe(
      true,
    );
    expect(
      paperlessRequests.some((request) => /documents\/\d+/.test(request.url)),
    ).toBe(true);
  });
});
