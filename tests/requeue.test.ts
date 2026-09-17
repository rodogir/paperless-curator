import { describe, expect, test } from "bun:test";
import type { Vocabularies } from "../src/decision.ts";
import { checkGapsFilled, decideRequeues } from "../src/requeue.ts";
import {
  REVIEW_STORE_VERSION,
  type ReviewRecord,
  type ReviewStore,
} from "../src/review.ts";
import { emptyVocab } from "./helpers.ts";

const nowMs = Date.parse("2026-01-02T10:00:00.000Z");

function record(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    documentId: 34,
    firstSeenAt: "2026-01-02T09:00:00.000Z",
    lastSeenAt: "2026-01-02T09:00:00.000Z",
    status: "review",
    requeueable: true,
    attempts: 1,
    lastRequeueAt: null,
    current: { title: "", correspondent: null, documentType: null, tags: [] },
    proposal: null,
    reviewReasons: [],
    missing: [
      { kind: "documentType", name: "Passport", reason: "identity document" },
    ],
    ...overrides,
  };
}

function store(records: ReviewRecord[]): ReviewStore {
  const documents: Record<string, ReviewRecord> = {};
  for (const entry of records) {
    documents[String(entry.documentId)] = entry;
  }
  return { version: REVIEW_STORE_VERSION, updatedAt: "", documents };
}

const vocab: Vocabularies = {
  ...emptyVocab(),
  documentTypes: [{ id: 18, name: "Passport" }],
};

describe("checkGapsFilled", () => {
  test("is filled when the missing entity exists", () => {
    expect(checkGapsFilled(record(), vocab)).toEqual({
      filled: true,
      pending: [],
    });
  });

  test("is not filled when the entity is absent or ambiguous", () => {
    expect(checkGapsFilled(record(), emptyVocab()).filled).toBe(false);
    const ambiguous: Vocabularies = {
      ...emptyVocab(),
      documentTypes: [
        { id: 1, name: "Passport" },
        { id: 2, name: "passport " },
      ],
    };
    expect(checkGapsFilled(record(), ambiguous).filled).toBe(false);
  });
});

describe("decideRequeues", () => {
  test("requeues a requeueable review document with filled gaps", () => {
    const decisions = decideRequeues({
      store: store([record()]),
      vocab,
      nowMs,
    });
    expect(decisions.map((entry) => entry.documentId)).toEqual([34]);
  });

  test("does not requeue when a gap remains", () => {
    expect(
      decideRequeues({ store: store([record()]), vocab: emptyVocab(), nowMs }),
    ).toEqual([]);
  });

  test("never requeues non-requeueable or failed records", () => {
    expect(
      decideRequeues({
        store: store([record({ requeueable: false })]),
        vocab,
        nowMs,
      }),
    ).toEqual([]);
    expect(
      decideRequeues({
        store: store([record({ status: "failed" })]),
        vocab,
        nowMs,
      }),
    ).toEqual([]);
  });

  test("never requeues a record with no missing entities", () => {
    expect(
      decideRequeues({ store: store([record({ missing: [] })]), vocab, nowMs }),
    ).toEqual([]);
  });

  test("rate-limits repeated requeues", () => {
    const recent = record({
      lastRequeueAt: new Date(nowMs - 60_000).toISOString(),
    });
    expect(decideRequeues({ store: store([recent]), vocab, nowMs })).toEqual(
      [],
    );

    const old = record({
      lastRequeueAt: new Date(nowMs - 10 * 60_000).toISOString(),
    });
    expect(decideRequeues({ store: store([old]), vocab, nowMs }).length).toBe(
      1,
    );
  });

  test("returns decisions in ascending document id order", () => {
    const decisions = decideRequeues({
      store: store([record({ documentId: 50 }), record({ documentId: 12 })]),
      vocab,
      nowMs,
    });
    expect(decisions.map((entry) => entry.documentId)).toEqual([12, 50]);
  });
});
