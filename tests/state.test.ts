import { describe, expect, test } from "bun:test";
import type { ProposedChanges } from "../src/decision.ts";
import type { StateTagIds } from "../src/metadata.ts";
import { buildDocumentUpdate, transitionTags } from "../src/state.ts";

const stateTagIds: StateTagIds = {
  pending: 70,
  processing: 71,
  processed: 72,
  review: 73,
  failed: 74,
};

const noChanges: ProposedChanges = {
  title: null,
  correspondentId: null,
  documentTypeId: null,
  addTagIds: [],
};

describe("transitionTags", () => {
  test("preserves non-state tags and swaps the state tag", () => {
    expect(transitionTags([70, 5, 9], stateTagIds, "processing")).toEqual([
      5, 9, 71,
    ]);
  });

  test("removes every other state tag", () => {
    expect(transitionTags([70, 71, 5], stateTagIds, "processed")).toEqual([
      5, 72,
    ]);
  });

  test("deduplicates and never drops user tags", () => {
    expect(transitionTags([5, 5, 70], stateTagIds, "review")).toEqual([5, 73]);
  });
});

describe("buildDocumentUpdate", () => {
  test("claims a pending document by swapping the state tag", () => {
    expect(
      buildDocumentUpdate({
        currentTags: [70, 5],
        changes: noChanges,
        stateTagIds,
        targetState: "processing",
      }),
    ).toEqual({ tags: [5, 71] });
  });

  test("returns null when the update would be a no-op", () => {
    expect(
      buildDocumentUpdate({
        currentTags: [5, 71],
        changes: noChanges,
        stateTagIds,
        targetState: "processing",
      }),
    ).toBeNull();
  });

  test("includes changed metadata and the final state together", () => {
    expect(
      buildDocumentUpdate({
        currentTags: [70],
        changes: {
          title: "New Title",
          correspondentId: 3,
          documentTypeId: 9,
          addTagIds: [5],
        },
        stateTagIds,
        targetState: "processed",
      }),
    ).toEqual({
      title: "New Title",
      correspondent: 3,
      document_type: 9,
      tags: [5, 72],
    });
  });

  test("omits unchanged metadata fields", () => {
    const update = buildDocumentUpdate({
      currentTags: [70],
      changes: { ...noChanges, title: "Only Title" },
      stateTagIds,
      targetState: "review",
    });
    expect(update).toEqual({ title: "Only Title", tags: [73] });
    expect(update).not.toHaveProperty("correspondent");
    expect(update).not.toHaveProperty("document_type");
  });

  test("treats an already-present state tag as a no-op", () => {
    expect(
      buildDocumentUpdate({
        currentTags: [5, 70],
        changes: noChanges,
        stateTagIds,
        targetState: "pending",
      }),
    ).toBeNull();
  });
});
