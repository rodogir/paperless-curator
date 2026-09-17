import type { Proposal } from "./llm.ts";
import {
  allStateTagIds,
  excludeStateTags,
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

export type Vocabularies = {
  tags: Tag[];
  correspondents: Correspondent[];
  documentTypes: DocumentType[];
};

export type ProposedChanges = {
  title: string | null;
  correspondentId: number | null;
  documentTypeId: number | null;
  addTagIds: number[];
};

export type DecisionOutcome = "update" | "noop" | "review";

export type Decision = {
  outcome: DecisionOutcome;
  changes: ProposedChanges;
  reviewReasons: string[];
  notes: string[];
};

export type DecisionInput = {
  document: DocumentDetail;
  proposal: Proposal;
  vocab: Vocabularies;
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

/**
 * Pure decision logic: turns a validated model proposal plus current document
 * state into explicit proposed changes. Performs no I/O and never removes
 * metadata. Every unsafe or unresolved outcome becomes a review reason.
 */
export function decideChanges(input: DecisionInput): Decision {
  const { document, proposal, vocab, stateTagIds, overwrite, maxTitleLength } =
    input;
  const changes = emptyChanges();
  const reviewReasons: string[] = [];
  const notes: string[] = [];

  if (proposal.review) {
    const reasons =
      proposal.reviewReasons.length > 0
        ? proposal.reviewReasons
        : ["model requested review without reasons"];
    for (const reason of reasons) {
      reviewReasons.push(`model review: ${reason}`);
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

    const resolution = resolveName(tagName, allowedTags);
    if (resolution.status === "unknown") {
      reviewReasons.push(`unknown tag suggestion "${tagName}"`);
      continue;
    }
    if (resolution.status === "ambiguous") {
      const ids = resolution.candidates
        .map((candidate) => candidate.id)
        .join(", ");
      reviewReasons.push(
        `ambiguous tag suggestion "${tagName}" matches ids ${ids}`,
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
    reviewReasons.push(`proposed title rejected: ${titleResult.reason}`);
  } else if (isBlank(document.title)) {
    changes.title = titleResult.title;
  } else if (overwrite.title && titleResult.title !== document.title.trim()) {
    changes.title = titleResult.title;
  } else {
    notes.push("existing title preserved");
  }

  if (isPresent(proposal.correspondent)) {
    const resolution = resolveName(
      proposal.correspondent,
      vocab.correspondents,
    );
    if (resolution.status === "unknown") {
      reviewReasons.push(
        `unknown correspondent suggestion "${proposal.correspondent}"`,
      );
    } else if (resolution.status === "ambiguous") {
      const ids = resolution.candidates
        .map((candidate) => candidate.id)
        .join(", ");
      reviewReasons.push(
        `ambiguous correspondent suggestion "${proposal.correspondent}" matches ids ${ids}`,
      );
    } else if (document.correspondent === null) {
      changes.correspondentId = resolution.value.id;
    } else if (
      overwrite.correspondent &&
      document.correspondent !== resolution.value.id
    ) {
      changes.correspondentId = resolution.value.id;
    } else {
      notes.push("existing correspondent preserved");
    }
  }

  if (isPresent(proposal.documentType)) {
    const resolution = resolveName(proposal.documentType, vocab.documentTypes);
    if (resolution.status === "unknown") {
      reviewReasons.push(
        `unknown document type suggestion "${proposal.documentType}"`,
      );
    } else if (resolution.status === "ambiguous") {
      const ids = resolution.candidates
        .map((candidate) => candidate.id)
        .join(", ");
      reviewReasons.push(
        `ambiguous document type suggestion "${proposal.documentType}" matches ids ${ids}`,
      );
    } else if (document.documentType === null) {
      changes.documentTypeId = resolution.value.id;
    } else if (
      overwrite.documentType &&
      document.documentType !== resolution.value.id
    ) {
      changes.documentTypeId = resolution.value.id;
    } else {
      notes.push("existing document type preserved");
    }
  }

  changes.addTagIds = [...addedTagIds];

  if (reviewReasons.length > 0) {
    return { outcome: "review", changes, reviewReasons, notes };
  }
  if (hasChanges(changes)) {
    return { outcome: "update", changes, reviewReasons, notes };
  }
  return { outcome: "noop", changes, reviewReasons, notes };
}
