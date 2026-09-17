import { describe, expect, test } from "bun:test";
import type { Decision } from "../src/decision.ts";
import type { Proposal } from "../src/llm.ts";
import type { DocumentDetail } from "../src/paperless.ts";
import {
  aggregateSuggestions,
  appendReviewLog,
  buildReviewLogEntry,
  buildReviewRecord,
  emptyReviewStore,
  loadReviewStore,
  markRequeued,
  parseReviewStore,
  type ReviewRecord,
  removeReviewRecord,
  renderReviewMarkdown,
  saveReviewStore,
  upsertReviewRecord,
} from "../src/review.ts";

const now = "2026-01-02T10:00:00.000Z";

const document: DocumentDetail = {
  id: 34,
  title: "DocScanner Sep 3",
  tags: [70, 5],
  correspondent: 3,
  documentType: null,
  created: "2026-09-03",
  content: "SECRET OCR TEXT THAT MUST NOT BE STORED",
  modified: "2026-09-03T10:00:00Z",
};

const proposal: Proposal = {
  title: "Passaporte do Brasil",
  tags: [],
  correspondent: null,
  documentType: null,
  review: false,
  reviewReasons: [],
  suggestedTags: [],
  suggestedCorrespondent: null,
  suggestedDocumentType: {
    name: "Passport",
    reason: "identity document",
  },
};

const decision: Decision = {
  outcome: "review",
  changes: {
    title: null,
    correspondentId: null,
    documentTypeId: null,
    addTagIds: [],
  },
  reviewReasons: ['missing whitelist entries: documentType "Passport"'],
  missing: [
    { kind: "documentType", name: "Passport", reason: "identity document" },
  ],
  requeueable: true,
  notes: [],
};

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    documentId: 34,
    firstSeenAt: now,
    lastSeenAt: now,
    status: "review",
    requeueable: true,
    attempts: 1,
    lastRequeueAt: null,
    current: {
      title: document.title,
      correspondent: null,
      documentType: null,
      tags: [],
    },
    proposal: null,
    reviewReasons: ["reason"],
    missing: [],
    ...overrides,
  };
}

describe("buildReviewRecord", () => {
  test("captures derived metadata without OCR text", () => {
    const built = buildReviewRecord({
      document,
      proposal,
      decision,
      status: "review",
      tagNames: new Map([
        [70, "ai-pending"],
        [5, "Invoice"],
      ]),
      correspondentNames: new Map([[3, "Example Correspondent"]]),
      documentTypeNames: new Map([[18, "Example Type"]]),
      now,
    });
    expect(built.documentId).toBe(34);
    expect(built.current).toEqual({
      title: "DocScanner Sep 3",
      correspondent: "Example Correspondent",
      documentType: null,
      tags: ["ai-pending", "Invoice"],
    });
    expect(built.proposal?.title).toBe("Passaporte do Brasil");
    expect(built.missing).toEqual([
      { kind: "documentType", name: "Passport", reason: "identity document" },
    ]);
    expect(JSON.stringify(built)).not.toContain("SECRET OCR");
  });

  test("preserves firstSeenAt and attempts across an update", () => {
    const existing = record({ firstSeenAt: "2026-01-01T00:00:00.000Z" });
    const built = buildReviewRecord({
      document,
      proposal: null,
      decision,
      status: "review",
      tagNames: new Map(),
      correspondentNames: new Map(),
      documentTypeNames: new Map(),
      now,
      existing,
    });
    expect(built.firstSeenAt).toBe("2026-01-01T00:00:00.000Z");
    expect(built.attempts).toBe(1);
    expect(built.lastSeenAt).toBe(now);
  });
});

describe("store operations", () => {
  test("upserts by document id and is idempotent", () => {
    const store = emptyReviewStore(now);
    const first = upsertReviewRecord(store, record(), now);
    const second = upsertReviewRecord(first, record(), now);
    expect(Object.keys(second.documents)).toEqual(["34"]);
    expect(second.documents["34"]?.documentId).toBe(34);
  });

  test("removes a record", () => {
    const store = upsertReviewRecord(emptyReviewStore(now), record(), now);
    const removed = removeReviewRecord(store, 34, now);
    expect(removed.documents).toEqual({});
  });

  test("markRequeued increments attempts and sets lastRequeueAt", () => {
    const updated = markRequeued(record(), now);
    expect(updated.attempts).toBe(2);
    expect(updated.lastRequeueAt).toBe(now);
  });

  test("builds a sanitized log entry", () => {
    const entry = buildReviewLogEntry(record(), now);
    expect(entry).toEqual({
      ts: now,
      documentId: 34,
      status: "review",
      requeueable: true,
      attempts: 1,
      reviewReasons: ["reason"],
      missing: [],
    });
  });
});

describe("parseReviewStore", () => {
  test("round-trips a store", () => {
    const store = upsertReviewRecord(emptyReviewStore(now), record(), now);
    const parsed = parseReviewStore(JSON.parse(JSON.stringify(store)));
    expect(parsed.documents["34"]?.status).toBe("review");
  });

  test("rejects an unsupported version", () => {
    expect(() => parseReviewStore({ version: 2, documents: {} })).toThrow(
      /unsupported review store version/,
    );
  });
});

describe("aggregateSuggestions", () => {
  test("groups across documents with counts, ids, and reasons", () => {
    let store = emptyReviewStore(now);
    store = upsertReviewRecord(
      store,
      record({
        documentId: 34,
        missing: [
          {
            kind: "documentType",
            name: "Passport",
            reason: "identity document",
          },
          { kind: "tag", name: "Rechnung", reason: "German invoice" },
        ],
      }),
      now,
    );
    store = upsertReviewRecord(
      store,
      record({
        documentId: 41,
        missing: [
          {
            kind: "documentType",
            name: "passport",
            reason: "identity document",
          },
        ],
      }),
      now,
    );
    store = upsertReviewRecord(
      store,
      record({ documentId: 99, status: "failed", missing: [] }),
      now,
    );

    const suggestions = aggregateSuggestions(store);
    expect(suggestions).toEqual([
      {
        kind: "tag",
        name: "Rechnung",
        documentIds: [34],
        reason: "German invoice",
      },
      {
        kind: "documentType",
        name: "Passport",
        documentIds: [34, 41],
        reason: "identity document",
      },
    ]);
  });
});

describe("renderReviewMarkdown", () => {
  test("renders aggregated suggestions and per-document reasons", () => {
    const store = upsertReviewRecord(
      emptyReviewStore(now),
      record({
        missing: [
          {
            kind: "documentType",
            name: "Passport",
            reason: "identity document",
          },
        ],
      }),
      now,
    );
    const markdown = renderReviewMarkdown(store);
    expect(markdown).toContain("## Suggested additions (not yet whitelisted)");
    expect(markdown).toContain(
      '- documentType "Passport" — 1 doc — "identity document"',
    );
    expect(markdown).toContain(
      "### Document 34 (review, requeueable, attempts 1)",
    );
    expect(markdown).toContain("- Reasons: reason");
  });

  test("renders an empty store", () => {
    const markdown = renderReviewMarkdown(emptyReviewStore(now));
    expect(markdown).toContain("None.");
  });
});

describe("file helpers", () => {
  const dir = `/tmp/opencode/paperless-curator-review`;

  test("loads an empty store when the file is missing", async () => {
    const store = await loadReviewStore(`${dir}/missing.json`, now);
    expect(store.documents).toEqual({});
  });

  test("saves, loads, and appends the log", async () => {
    const path = `${dir}/review.json`;
    const logPath = `${dir}/review-log.jsonl`;
    await Bun.write(`${dir}/.keep`, "");
    const store = upsertReviewRecord(emptyReviewStore(now), record(), now);
    await saveReviewStore(path, store);
    const loaded = await loadReviewStore(path, now);
    expect(loaded.documents["34"]?.documentId).toBe(34);

    await Bun.write(logPath, "");
    const entry = buildReviewLogEntry(record(), now);
    await appendReviewLog(logPath, entry);
    await appendReviewLog(logPath, entry);
    const lines = (await Bun.file(logPath).text()).trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0] ?? "{}").documentId).toBe(34);
  });
});
