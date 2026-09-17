import type { StateTagConfig } from "./config.ts";
import type { Proposal } from "./llm.ts";
import {
  allStateTagIds,
  excludeStateTags,
  type NamedEntity,
  normalizeName,
  resolveName,
  type StateTagIds,
} from "./metadata.ts";
import type {
  Correspondent,
  DocumentDetail,
  DocumentType,
  Tag,
} from "./paperless.ts";
import { isBlank, isPresent, validateTitle } from "./text.ts";
import {
  resolveWhitelistName,
  stateTagKeys,
  type WhitelistEntry,
} from "./whitelist.ts";

export type Vocabularies = {
  tags: Tag[];
  correspondents: Correspondent[];
  documentTypes: DocumentType[];
};

export type WhitelistInput = {
  tags: WhitelistEntry[];
  correspondents: WhitelistEntry[];
  documentTypes: WhitelistEntry[];
};

export type ProposedChanges = {
  title: string | null;
  correspondentId: number | null;
  documentTypeId: number | null;
  addTagIds: number[];
};

export type DecisionOutcome = "update" | "noop" | "review";

export type MissingEntityKind = "tag" | "correspondent" | "documentType";

export type MissingEntity = {
  kind: MissingEntityKind;
  name: string;
  reason: string;
};

export type Decision = {
  outcome: DecisionOutcome;
  changes: ProposedChanges;
  reviewReasons: string[];
  missing: MissingEntity[];
  requeueable: boolean;
  notes: string[];
};

export type DecisionInput = {
  document: DocumentDetail;
  proposal: Proposal;
  vocab: Vocabularies;
  whitelist: WhitelistInput;
  stateTags: StateTagConfig;
  stateTagIds: StateTagIds;
  overwrite: { title: boolean; correspondent: boolean; documentType: boolean };
  maxTitleLength: number;
};

function emptyChanges(): ProposedChanges {
  return {
    title: null,
    correspondentId: null,
    documentTypeId: null,
    addTagIds: [],
  };
}

function hasChanges(changes: ProposedChanges): boolean {
  return (
    changes.title !== null ||
    changes.correspondentId !== null ||
    changes.documentTypeId !== null ||
    changes.addTagIds.length > 0
  );
}

function kindLabel(kind: MissingEntityKind): string {
  return kind === "tag"
    ? "tag"
    : kind === "correspondent"
      ? "correspondent"
      : "document type";
}

function missingKey(kind: MissingEntityKind, name: string): string {
  return `${kind}|${normalizeName(name)}`;
}

function addMissing(
  missing: Map<string, MissingEntity>,
  kind: MissingEntityKind,
  name: string,
  reason: string,
): void {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return;
  }
  const key = missingKey(kind, trimmed);
  if (!missing.has(key)) {
    missing.set(key, { kind, name: trimmed, reason });
  }
}

type EntitySelection = {
  kind: MissingEntityKind;
  query: string;
  whitelist: readonly WhitelistEntry[];
  paperless: readonly NamedEntity[];
  currentId: number | null;
  overwrite: boolean;
  preservedNote: string;
  stateKeys: ReadonlySet<string>;
  missing: Map<string, MissingEntity>;
  hardReasons: string[];
  notes: string[];
};

/**
 * Resolves a model-provided metadata value through the whitelist to a Paperless
 * id. Whitelist gaps become `missing` entries; ambiguity, entity-not-present, or
 * Paperless ambiguity become hard (non-requeueable) review reasons.
 */
function resolveEntitySelection(args: EntitySelection): number | null {
  const { kind, query, missing, hardReasons, notes } = args;
  const label = kindLabel(kind);

  if (args.stateKeys.has(normalizeName(query))) {
    hardReasons.push(`model proposed a worker state tag "${query}"`);
    return null;
  }

  const whitelist = resolveWhitelistName(query, args.whitelist);

  if (whitelist.status === "unknown") {
    addMissing(
      missing,
      kind,
      query,
      "model proposed it but it is not in the whitelist",
    );
    return null;
  }
  if (whitelist.status === "ambiguous") {
    hardReasons.push(`ambiguous ${label} "${query}" in the whitelist`);
    return null;
  }

  const canonical = whitelist.entry.name;
  const resolution = resolveName(canonical, args.paperless);
  if (resolution.status === "unknown") {
    hardReasons.push(
      `whitelisted ${label} "${canonical}" is not present in Paperless yet`,
    );
    return null;
  }
  if (resolution.status === "ambiguous") {
    hardReasons.push(
      `${label} "${canonical}" matches multiple Paperless entries`,
    );
    return null;
  }

  if (args.currentId === null) {
    return resolution.value.id;
  }
  if (args.overwrite && args.currentId !== resolution.value.id) {
    return resolution.value.id;
  }
  notes.push(args.preservedNote);
  return null;
}

/**
 * Pure decision logic: turns a validated `proposal-v2` plus current document
 * state into explicit proposed changes. Performs no I/O and never removes
 * metadata. Every unsafe or unresolved outcome becomes a review reason.
 *
 * `requeueable` is true only when review was required solely by whitelist gaps
 * recorded in `missing`; model uncertainty, ambiguity, invalid output, or
 * entities already whitelisted but absent from Paperless are not requeueable.
 */
export function decideChanges(input: DecisionInput): Decision {
  const {
    document,
    proposal,
    vocab,
    whitelist,
    stateTags,
    stateTagIds,
    overwrite,
    maxTitleLength,
  } = input;
  const changes = emptyChanges();
  const hardReasons: string[] = [];
  const notes: string[] = [];
  const missing = new Map<string, MissingEntity>();
  const stateKeys = stateTagKeys(stateTags);

  if (proposal.review) {
    const reasons =
      proposal.reviewReasons.length > 0
        ? proposal.reviewReasons
        : ["model requested review without reasons"];
    for (const reason of reasons) {
      hardReasons.push(`model review: ${reason}`);
    }
  }

  const allowedTags = excludeStateTags(vocab.tags, allStateTagIds(stateTagIds));
  const existingTagIds = new Set(document.tags);
  const addedTagIds = new Set<number>();
  const seenTagQueries = new Set<string>();

  for (const tagName of proposal.tags) {
    const key = normalizeName(tagName);
    if (key.length === 0 || seenTagQueries.has(key)) {
      continue;
    }
    seenTagQueries.add(key);

    if (stateKeys.has(key)) {
      hardReasons.push(`model proposed a worker state tag "${tagName}"`);
      continue;
    }

    const whitelistMatch = resolveWhitelistName(tagName, whitelist.tags);
    if (whitelistMatch.status === "unknown") {
      addMissing(
        missing,
        "tag",
        tagName,
        "model proposed it but it is not in the whitelist",
      );
      continue;
    }
    if (whitelistMatch.status === "ambiguous") {
      hardReasons.push(`ambiguous tag "${tagName}" in the whitelist`);
      continue;
    }

    const resolution = resolveName(whitelistMatch.entry.name, allowedTags);
    if (resolution.status === "unknown") {
      hardReasons.push(
        `whitelisted tag "${whitelistMatch.entry.name}" is not present in Paperless yet`,
      );
      continue;
    }
    if (resolution.status === "ambiguous") {
      hardReasons.push(
        `tag "${whitelistMatch.entry.name}" matches multiple Paperless tags`,
      );
      continue;
    }

    const tagId = resolution.value.id;
    if (existingTagIds.has(tagId)) {
      notes.push(`tag "${resolution.value.name}" already present`);
    } else if (!addedTagIds.has(tagId)) {
      addedTagIds.add(tagId);
    }
  }

  const titleResult = validateTitle(proposal.title, maxTitleLength);
  if (!titleResult.ok) {
    hardReasons.push(`proposed title rejected: ${titleResult.reason}`);
  } else if (isBlank(document.title)) {
    changes.title = titleResult.title;
  } else if (overwrite.title && titleResult.title !== document.title.trim()) {
    changes.title = titleResult.title;
  } else {
    notes.push("existing title preserved");
  }

  if (isPresent(proposal.correspondent)) {
    changes.correspondentId = resolveEntitySelection({
      kind: "correspondent",
      query: proposal.correspondent,
      whitelist: whitelist.correspondents,
      paperless: vocab.correspondents,
      currentId: document.correspondent,
      overwrite: overwrite.correspondent,
      preservedNote: "existing correspondent preserved",
      stateKeys,
      missing,
      hardReasons,
      notes,
    });
  }

  if (isPresent(proposal.documentType)) {
    changes.documentTypeId = resolveEntitySelection({
      kind: "documentType",
      query: proposal.documentType,
      whitelist: whitelist.documentTypes,
      paperless: vocab.documentTypes,
      currentId: document.documentType,
      overwrite: overwrite.documentType,
      preservedNote: "existing document type preserved",
      stateKeys,
      missing,
      hardReasons,
      notes,
    });
  }

  for (const suggestion of proposal.suggestedTags) {
    const match = resolveWhitelistName(suggestion.name, whitelist.tags);
    if (match.status === "resolved") {
      notes.push(`suggested tag "${suggestion.name}" is already whitelisted`);
      continue;
    }
    if (match.status === "ambiguous") {
      hardReasons.push(`ambiguous suggested tag "${suggestion.name}"`);
      continue;
    }
    addMissing(missing, "tag", suggestion.name, suggestion.reason);
  }

  if (proposal.suggestedCorrespondent !== null) {
    const suggestion = proposal.suggestedCorrespondent;
    const match = resolveWhitelistName(
      suggestion.name,
      whitelist.correspondents,
    );
    if (match.status === "resolved") {
      notes.push(
        `suggested correspondent "${suggestion.name}" is already whitelisted`,
      );
    } else if (match.status === "ambiguous") {
      hardReasons.push(
        `ambiguous suggested correspondent "${suggestion.name}"`,
      );
    } else {
      addMissing(missing, "correspondent", suggestion.name, suggestion.reason);
    }
  }

  if (proposal.suggestedDocumentType !== null) {
    const suggestion = proposal.suggestedDocumentType;
    const match = resolveWhitelistName(
      suggestion.name,
      whitelist.documentTypes,
    );
    if (match.status === "resolved") {
      notes.push(
        `suggested document type "${suggestion.name}" is already whitelisted`,
      );
    } else if (match.status === "ambiguous") {
      hardReasons.push(
        `ambiguous suggested document type "${suggestion.name}"`,
      );
    } else {
      addMissing(missing, "documentType", suggestion.name, suggestion.reason);
    }
  }

  changes.addTagIds = [...addedTagIds];

  const missingList = [...missing.values()];
  const reviewReasons = [...hardReasons];
  if (missingList.length > 0) {
    reviewReasons.push(
      `missing whitelist entries: ${missingList
        .map((entry) => `${entry.kind} "${entry.name}"`)
        .join(", ")}`,
    );
  }

  if (reviewReasons.length > 0) {
    return {
      outcome: "review",
      changes,
      reviewReasons,
      missing: missingList,
      requeueable: hardReasons.length === 0 && missingList.length > 0,
      notes,
    };
  }
  if (hasChanges(changes)) {
    return {
      outcome: "update",
      changes,
      reviewReasons,
      missing: missingList,
      requeueable: false,
      notes,
    };
  }
  return {
    outcome: "noop",
    changes,
    reviewReasons,
    missing: missingList,
    requeueable: false,
    notes,
  };
}
