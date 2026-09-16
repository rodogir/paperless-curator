import { describe, expect, test } from "bun:test";
import { decideChanges, type DecisionInput } from "../src/decision.ts";
import type { Proposal } from "../src/llm.ts";
import type { DocumentDetail } from "../src/paperless.ts";
import type { StateTagIds } from "../src/metadata.ts";

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
};

const input: DecisionInput = {
  document: baseDocument,
  proposal: baseProposal,
  vocab: {
    tags: [
      { id: 70, name: "ai-pending" },
      { id: 5, name: "Example Tag" },
      { id: 6, name: "Invoices" },
      { id: 7, name: "invoices " },
    ],
    correspondents: [{ id: 5, name: "Example Correspondent" }],
    documentTypes: [{ id: 18, name: "Example Type" }],
  },
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

  test("routes unknown tag suggestions to review", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["Nonexistent"] } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.reviewReasons[0]).toContain("unknown tag");
  });

  test("routes ambiguous tag suggestions to review", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["invoices"] } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.reviewReasons[0]).toContain("ambiguous tag");
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

  test("never allows a state tag to be selected", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, tags: ["ai-pending"] } }),
    );
    expect(decision.outcome).toBe("review");
    expect(decision.changes.addTagIds).toEqual([]);
    expect(decision.reviewReasons[0]).toContain("unknown tag");
  });

  test("honors the model review decision", () => {
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
    expect(decision.reviewReasons).toContain("model review: unreadable scan");
    expect(decision.changes.title).toBe("New Title");
  });

  test("routes an invalid title to review", () => {
    const decision = decideChanges(
      withInput({ proposal: { ...baseProposal, title: "" } }),
    );
    expect(decision.outcome).toBe("review");
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
