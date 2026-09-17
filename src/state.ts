import type { ProposedChanges } from "./decision.ts";
import { allStateTagIds, type StateTagIds } from "./metadata.ts";

export type StateRole = keyof StateTagIds;

function unique(values: readonly number[]): number[] {
  return [...new Set(values)];
}

/**
 * Computes the document's tag ids after a state transition. All other state
 * tags are replaced and every non-state tag is preserved.
 */
export function transitionTags(
  currentTags: readonly number[],
  stateTagIds: StateTagIds,
  target: StateRole,
): number[] {
  const state = new Set(allStateTagIds(stateTagIds));
  const nonState = currentTags.filter((id) => !state.has(id));
  return unique([...nonState, stateTagIds[target]]);
}

export type DocumentUpdate = {
  title?: string;
  correspondent?: number;
  document_type?: number;
  tags?: number[];
};

function sameTagSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  for (const id of b) {
    if (!setA.has(id)) {
      return false;
    }
  }
  return true;
}

export type BuildUpdateArgs = {
  currentTags: readonly number[];
  changes: ProposedChanges;
  stateTagIds: StateTagIds;
  targetState: StateRole;
};

/**
 * Builds the smallest safe Paperless PATCH body: only changed metadata fields,
 * state tags kept mutually exclusive, and all non-state tags preserved. Returns
 * null when the update would be a no-op.
 */
export function buildDocumentUpdate(
  args: BuildUpdateArgs,
): DocumentUpdate | null {
  const { currentTags, changes, stateTagIds, targetState } = args;
  const base = unique(currentTags);
  const withAdds = unique([...base, ...changes.addTagIds]);
  const finalTags = transitionTags(withAdds, stateTagIds, targetState);

  const update: DocumentUpdate = {};
  if (!sameTagSet(finalTags, base)) {
    update.tags = finalTags;
  }
  if (changes.title !== null) {
    update.title = changes.title;
  }
  if (changes.correspondentId !== null) {
    update.correspondent = changes.correspondentId;
  }
  if (changes.documentTypeId !== null) {
    update.document_type = changes.documentTypeId;
  }

  if (Object.keys(update).length === 0) {
    return null;
  }
  return update;
}
