import type { StateTagConfig } from "./config.ts";

export type NamedEntity = { id: number; name: string };

export type Resolution<T extends NamedEntity> =
  | { status: "resolved"; value: T }
  | { status: "unknown"; query: string }
  | { status: "ambiguous"; query: string; candidates: T[] };

/**
 * Trims, Unicode-normalizes (NFKC), collapses internal whitespace, and
 * lowercases a name for case-insensitive comparison.
 */
export function normalizeName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function resolveName<T extends NamedEntity>(
  query: string,
  candidates: readonly T[],
): Resolution<T> {
  const target = normalizeName(query);
  if (target.length === 0) {
    return { status: "unknown", query };
  }
  const matches = candidates.filter(
    (candidate) => normalizeName(candidate.name) === target,
  );
  if (matches.length === 0) {
    return { status: "unknown", query };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", query, candidates: matches };
  }
  const match = matches[0];
  if (match === undefined) {
    return { status: "unknown", query };
  }
  return { status: "resolved", value: match };
}

export type StateTagRoles = StateTagConfig;

export type StateTagIds = {
  pending: number;
  processing: number;
  processed: number;
  review: number;
  failed: number;
};

export type StateTagResolution =
  | { ok: true; ids: StateTagIds; all: number[] }
  | { ok: false; problems: string[] };

/**
 * Confirms that each configured state tag exists exactly once by normalized
 * name. Missing or duplicate tags are reported, never repaired.
 */
export function resolveStateTags(
  tags: readonly NamedEntity[],
  stateTags: StateTagConfig,
): StateTagResolution {
  const problems: string[] = [];
  const resolved: Partial<StateTagIds> = {};

  for (const role of Object.keys(stateTags) as (keyof StateTagConfig)[]) {
    const result = resolveName(stateTags[role], tags);
    if (result.status === "resolved") {
      resolved[role] = result.value.id;
    } else if (result.status === "unknown") {
      problems.push(`state tag "${stateTags[role]}" (${role}) does not exist`);
    } else {
      const ids = result.candidates.map((candidate) => candidate.id).join(", ");
      problems.push(
        `state tag "${stateTags[role]}" (${role}) is ambiguous across ids ${ids}`,
      );
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const ids = resolved as StateTagIds;
  return {
    ok: true,
    ids,
    all: Object.values(ids),
  };
}

export function allStateTagIds(ids: StateTagIds): number[] {
  return [ids.pending, ids.processing, ids.processed, ids.review, ids.failed];
}

export function excludeStateTags<T extends NamedEntity>(
  tags: readonly T[],
  stateTagIds: readonly number[],
): T[] {
  const excluded = new Set(stateTagIds);
  return tags.filter((tag) => !excluded.has(tag.id));
}
