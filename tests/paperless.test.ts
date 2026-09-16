import { describe, expect, test } from "bun:test";
import {
  checkEligibility,
  getDocument,
  getStatus,
  listCorrespondents,
  listDocumentTypes,
  listPendingDocuments,
  listTags,
  type PaperlessContext,
} from "../src/paperless.ts";
import { jsonResponse, loadFixture } from "./helpers.ts";

const fixtures = {
  status: await loadFixture("paperless/status.json"),
  tags1: await loadFixture("paperless/tags-page-1.json"),
  tags2: await loadFixture("paperless/tags-page-2.json"),
  correspondents: await loadFixture("paperless/correspondents-page.json"),
  documentTypes: await loadFixture("paperless/document-types-page.json"),
  documents: await loadFixture("paperless/documents-pending.json"),
  detail: await loadFixture("paperless/document-detail.json"),
};

const seenUrls: string[] = [];

const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input));
  seenUrls.push(url.toString());
  const path = url.pathname;
  if (path === "/api/status/") return jsonResponse(fixtures.status);
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

function context(): PaperlessContext {
  return {
    baseUrl: "https://paperless.invalid",
    token: "test-token",
    fetchImpl,
    retry: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
  };
}

describe("paperless client", () => {
  test("reads the server version", async () => {
    expect(await getStatus(context())).toEqual({ version: "3.0.0" });
  });

  test("follows pagination across tag pages", async () => {
    const tags = await listTags(context());
    expect(tags.length).toBe(6);
    expect(tags[0]).toEqual({ id: 70, name: "ai-pending" });
    expect(tags[5]).toEqual({ id: 27, name: "Example Tag" });
  });

  test("lists correspondents and document types", async () => {
    expect(await listCorrespondents(context())).toEqual([
      { id: 5, name: "Example Correspondent" },
    ]);
    expect(await listDocumentTypes(context())).toEqual([
      { id: 18, name: "Example Type" },
    ]);
  });

  test("requests the projected document fields and parses summaries", async () => {
    seenUrls.length = 0;
    const documents = await listPendingDocuments(context(), 70);
    expect(documents).toEqual([
      {
        id: 123,
        title: "Scanned Document 2026-01-01",
        tags: [70],
        correspondent: null,
        documentType: null,
        created: "2026-01-01",
      },
      {
        id: 124,
        title: "Example Statement",
        tags: [27, 70],
        correspondent: 5,
        documentType: 18,
        created: "2025-12-15",
      },
    ]);
    const requested = new URL(seenUrls[0] ?? "");
    expect(requested.searchParams.get("tags__id__all")).toBe("70");
    expect(requested.searchParams.get("fields")).toContain("document_type");
    expect(requested.searchParams.get("ordering")).toBe("id");
  });

  test("fetches a document detail including content", async () => {
    const document = await getDocument(context(), 123);
    expect(document.content).toBe("[OCR text removed from fixture]");
    expect(document.modified).toBe("2026-01-02T10:00:00.000000+01:00");
  });
});

describe("checkEligibility", () => {
  const stateTagIds = {
    pending: 70,
    processing: 71,
    processed: 72,
    review: 73,
    failed: 74,
  };

  test("accepts a document with only the pending tag", () => {
    expect(checkEligibility([70], stateTagIds)).toEqual({ eligible: true });
    expect(checkEligibility([27, 70], stateTagIds)).toEqual({ eligible: true });
  });

  test("rejects a document without the pending tag", () => {
    expect(checkEligibility([27], stateTagIds)).toEqual({
      eligible: false,
      reason: "missing-pending-tag",
    });
  });

  test("rejects conflicting state tags without repairing them", () => {
    expect(checkEligibility([70, 72], stateTagIds)).toEqual({
      eligible: false,
      reason: "conflicting-state-tags",
      conflicting: [72],
    });
  });
});
