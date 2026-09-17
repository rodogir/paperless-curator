import { describe, expect, test } from "bun:test";
import { DEFAULT_STATE_TAGS } from "../src/config.ts";
import { type DecisionInput, decideChanges } from "../src/decision.ts";
import type { Proposal } from "../src/llm.ts";
import type { StateTagIds } from "../src/metadata.ts";
import type { DocumentDetail } from "../src/paperless.ts";

const stateTagIds: StateTagIds = {
  pending: 70,
  processing: 71,
  processed: 72,
  review: 73,
  failed: 74,
};

const baseDocument: DocumentDetail = {
  id: 123,
  title: "",
  tags: [70],
  correspondent: null,
  documentType: null,
  created: "2026-01-01",
  content: "synthetic",
  modified: "2026-01-02T00:00:00Z",
};

const baseProposal: Proposal = {
  title: "New Title",
  tags: ["Example Tag"],
  correspondent: "Example Correspondent",
  documentType: "Example Type",
  review: false,
  reviewReasons: [],
  suggestedTags: [],
  suggestedCorrespondent: null,
  suggestedDocumentType: null,
};

const input: DecisionInput = {
  document: baseDocument,
  proposal: baseProposal,
  vocab: {
    tags: [
      { id: 70, name: "ai-pending" },
      { id: 5, name: "Example Tag" },
      { id: 6, name: "Invoices" },
      { id: 7, name: "Dup" },
      { id: 8, name: "dup " },
    ],
    correspondents: [{ id: 5, name: "Example Correspondent" }],
    documentTypes: [{ id: 18, name: "Example Type" }],
  },
  whitelist: {
    tags: [
      { name: "Example Tag", aliases: [], description: null },
      { name: "Invoices", aliases: ["Rechnung"], description: null },
      { name: "Dup", aliases: [], description: null },
    ],
    correspondents: [
      { name: "Example Correspondent", aliases: [], description: null },
    ],
    documentTypes: [{ name: "Example Type", aliases: [], description: null }],
  },
  stateTags: DEFAULT_STATE_TAGS,
  stateTagIds,
  overwrite: { title: false, correspondent: false, documentType: false },
  maxTitleLength: 128,
};

function withInput(overrides: Partial<DecisionInput>): DecisionInput {
  return { ...input, ...overrides };
}

describe("decideChanges", () => {
  test("populates empty metadata and adds tags", () => {
    const decision = decideChanges(input);
    expect(decision.outcome).toBe("update");
    expect(decision.changes).toEqual({
      title: "New Title",
      correspondentId: 5,
      documentTypeId: 18,
      addTagIds: [5],
    });
    expect(decision.reviewReasons).toEqual([]);
    expect(decision.missing).toEqual([]);
    expect(decision.requeueable).toBe(false);
  });

  test("resolves a whitelist alias to its canonical entry", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["Rechnung"] } }),
    );
    expect(decision.outcome).toBe("update");
    expect(decision.changes.addTagIds).toEqual([6]);
  });

  test("preserves existing metadata when overwrite is disabled", () => {
    const decision = decideChanges(
      withInput({
        document: {
          ...baseDocument,
          title: "Existing",
          correspondent: 9,
          documentType: 99,
          tags: [70, 5],
        },
      }),
    );
    expect(decision.outcome).toBe("noop");
    expect(decision.changes).toEqual({
      title: null,
      correspondentId: null,
      documentTypeId: null,
      addTagIds: [],
    });
    expect(decision.notes).toContain("existing title preserved");
    expect(decision.notes).toContain("existing correspondent preserved");
    expect(decision.notes).toContain("existing document type preserved");
  });

  test("overwrites existing metadata when enabled", () => {
    const decision = decideChanges(
      withInput({
        document: {
          ...baseDocument,
          title: "Existing",
          correspondent: 9,
          documentType: 99,
        },
        overwrite: { title: true, correspondent: true, documentType: true },
      }),
    );
    expect(decision.outcome).toBe("update");
    expect(decision.changes.title).toBe("New Title");
    expect(decision.changes.correspondentId).toBe(5);
    expect(decision.changes.documentTypeId).toBe(18);
  });

  test("records an unknown tag as a requeueable whitelist gap", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["Nonexistent"] } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.requeueable).toBe(true);
    expect(decision.missing).toEqual([
      {
        kind: "tag",
        name: "Nonexistent",
        reason: "model proposed it but it is not in the whitelist",
      },
    ]);
    expect(decision.reviewReasons[0]).toContain("missing whitelist entries");
  });

  test("records a suggested document type as a requeueable gap", () => {
    const decision = decideChanges(
      withInput({
        proposal: {
          ...baseProposal,
          suggestedDocumentType: {
            name: "Passport",
            reason: "identity document",
          },
        },
      }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.requeueable).toBe(true);
    expect(decision.missing).toEqual([
      { kind: "documentType", name: "Passport", reason: "identity document" },
    ]);
  });

  test("deduplicates a tag proposed in both tags and suggestions", () => {
    const decision = decideChanges(
      withInput({
        proposal: {
          ...baseProposal,
          tags: ["Passport"],
          suggestedTags: [{ name: "passport", reason: "identity document" }],
        },
      }),
    );
    expect(decision.missing.length).toBe(1);
    expect(decision.missing[0]?.reason).toBe(
      "model proposed it but it is not in the whitelist",
    );
  });

  test("ignores a suggestion that is already whitelisted", () => {
    const decision = decideChanges(
      withInput({
        proposal: {
          ...baseProposal,
          suggestedTags: [{ name: "Example Tag", reason: "already there" }],
        },
      }),
    );
    expect(decision.missing).toEqual([]);
    expect(decision.notes).toContain(
      'suggested tag "Example Tag" is already whitelisted',
    );
  });

  test("routes ambiguous Paperless tags to non-requeueable review", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["dup"] } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.requeueable).toBe(false);
    expect(decision.missing).toEqual([]);
    expect(decision.reviewReasons[0]).toContain("matches multiple Paperless");
  });

  test("treats a duplicate tag suggestion as a no-op", () => {
    const decision = decideChanges(
      withInput({
        document: { ...baseDocument, tags: [70, 5] },
        proposal: { ...baseProposal, tags: ["Example Tag"] },
      }),
    );
    expect(decision.changes.addTagIds).toEqual([]);
    expect(decision.notes).toContain('tag "Example Tag" already present');
  });

  test("never allows a state tag to be selected or suggested", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["ai-pending"] } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.changes.addTagIds).toEqual([]);
    expect(decision.missing).toEqual([]);
    expect(decision.requeueable).toBe(false);
    expect(decision.reviewReasons[0]).toContain("worker state tag");
  });

  test("honors the model review decision as non-requeueable", () => {
    const decision = decideChanges(
      withInput({
        proposal: {
          ...baseProposal,
          review: true,
          reviewReasons: ["unreadable scan"],
        },
      }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.requeueable).toBe(false);
    expect(decision.reviewReasons).toContain("model review: unreadable scan");
  });

  test("marks a combined uncertainty and gap review as non-requeueable", () => {
    const decision = decideChanges(
      withInput({
        proposal: {
          ...baseProposal,
          review: true,
          reviewReasons: ["unreadable scan"],
          suggestedTags: [{ name: "Passport", reason: "identity document" }],
        },
      }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.requeueable).toBe(false);
    expect(decision.missing.length).toBe(1);
  });

  test("routes an invalid title to review", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, title: "" } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.requeueable).toBe(false);
    expect(decision.reviewReasons[0]).toContain("proposed title rejected");
  });

  test("reports no-op when nothing needs changing", () => {
    const decision = decideChanges(
      withInput({
        document: {
          ...baseDocument,
          title: "New Title",
          correspondent: 5,
          documentType: 18,
          tags: [70, 5],
        },
      }),
    );
    expect(decision.outcome).toBe("noop");
    expect(decision.reviewReasons).toEqual([]);
  });
});
