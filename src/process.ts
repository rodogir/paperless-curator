import type { AppConfig } from "./config.ts";
import { type Decision, decideChanges, type Vocabularies } from "./decision.ts";
import {
  callModel,
  type LlmContext,
  type LlmUsage,
  type Proposal,
} from "./llm.ts";
import type { Logger } from "./logger.ts";
import type { StateTagIds } from "./metadata.ts";
import { allStateTagIds, excludeStateTags } from "./metadata.ts";
import {
  checkEligibility,
  type DocumentDetail,
  getDocument,
  listPendingDocuments,
  type PaperlessContext,
} from "./paperless.ts";
import { prepareOcr } from "./text.ts";
import type { Whitelist } from "./whitelist.ts";

export type ProcessDeps = {
  config: AppConfig;
  paperless: PaperlessContext;
  llm: LlmContext;
  vocab: Vocabularies;
  whitelist: Whitelist;
  stateTagIds: StateTagIds;
  log: Logger;
  /**
   * Optional explicit document id for a deliberately selected test document.
   * Only an eligible document is processed; otherwise the run is a no-op.
   */
  targetDocumentId?: number;
};

export type Classification =
  | {
      kind: "classified";
      documentId: number;
      decision: Decision;
      proposal: Proposal | null;
      usage: LlmUsage | null;
      promptVersion: string | null;
      ocr: { chars: number; originalChars: number; truncated: boolean } | null;
      durationMs: number;
    }
  | {
      kind: "model-invalid";
      documentId: number;
      reason: string;
      promptVersion: string;
      durationMs: number;
    };

export type ProcessOutcome =
  | { kind: "no-candidate" }
  | Extract<Classification, { kind: "classified" }>
  | Extract<Classification, { kind: "model-invalid" }>;

function nameById(
  entries: readonly { id: number; name: string }[],
): Map<number, string> {
  return new Map(entries.map((entry) => [entry.id, entry.name]));
}

function currentTagNames(
  document: DocumentDetail,
  vocab: Vocabularies,
  stateTagIds: StateTagIds,
): string[] {
  const names = nameById(vocab.tags);
  const selectable = excludeStateTags(vocab.tags, allStateTagIds(stateTagIds));
  const selectableIds = new Set(selectable.map((tag) => tag.id));
  return document.tags
    .filter((id) => selectableIds.has(id))
    .map((id) => names.get(id) ?? String(id));
}

/**
 * Selects one eligible document, either the explicit target or the first
 * pending document without a conflicting state tag. Read-only.
 */
export async function findEligibleDocument(
  deps: ProcessDeps,
): Promise<{ document: DocumentDetail | null; candidateCount: number }> {
  const { paperless, stateTagIds, log } = deps;
  let candidateCount = 0;

  if (deps.targetDocumentId !== undefined) {
    const detail = await getDocument(paperless, deps.targetDocumentId);
    candidateCount = 1;
    const eligibility = checkEligibility(detail.tags, stateTagIds);
    if (!eligibility.eligible) {
      log("warn", "document-skipped", {
        documentId: detail.id,
        reason: eligibility.reason,
        conflictingStateTagIds:
          eligibility.reason === "conflicting-state-tags"
            ? eligibility.conflicting
            : undefined,
      });
      return { document: null, candidateCount };
    }
    return { document: detail, candidateCount };
  }

  const candidates = await listPendingDocuments(paperless, stateTagIds.pending);
  candidateCount = candidates.length;
  for (const candidate of candidates) {
    const eligibility = checkEligibility(candidate.tags, stateTagIds);
    if (!eligibility.eligible) {
      log("warn", "document-skipped", {
        documentId: candidate.id,
        reason: eligibility.reason,
        conflictingStateTagIds:
          eligibility.reason === "conflicting-state-tags"
            ? eligibility.conflicting
            : undefined,
      });
      continue;
    }
    return {
      document: await getDocument(paperless, candidate.id),
      candidateCount,
    };
  }
  return { document: null, candidateCount };
}

function reviewForUnusableOcr(reason: string): Decision {
  return {
    outcome: "review",
    changes: {
      title: null,
      correspondentId: null,
      documentTypeId: null,
      addTagIds: [],
    },
    reviewReasons: [`unusable OCR: ${reason}`],
    missing: [],
    requeueable: false,
    notes: [],
  };
}

/**
 * Classifies one already-selected document: prepares OCR, calls the model, and
 * resolves a safe decision. Performs no Paperless mutations.
 */
export async function classifyDocument(
  deps: ProcessDeps,
  document: DocumentDetail,
): Promise<Classification> {
  const { config, llm, vocab, whitelist, stateTagIds } = deps;
  const startedAt = Date.now();

  const ocr = prepareOcr(document.content, config.limits.maxOcrChars);
  if (!ocr.ok) {
    return {
      kind: "classified",
      documentId: document.id,
      decision: reviewForUnusableOcr(ocr.reason),
      proposal: null,
      usage: null,
      promptVersion: null,
      ocr: null,
      durationMs: Date.now() - startedAt,
    };
  }

  const correspondents = nameById(vocab.correspondents);
  const documentTypes = nameById(vocab.documentTypes);

  const result = await callModel(llm, {
    ocr: ocr.text,
    allowedTags: whitelist.tags,
    allowedCorrespondents: whitelist.correspondents,
    allowedDocumentTypes: whitelist.documentTypes,
    current: {
      title: document.title,
      correspondent:
        document.correspondent === null
          ? null
          : (correspondents.get(document.correspondent) ?? null),
      documentType:
        document.documentType === null
          ? null
          : (documentTypes.get(document.documentType) ?? null),
      tags: currentTagNames(document, vocab, stateTagIds),
    },
  });

  if (!result.ok) {
    return {
      kind: "model-invalid",
      documentId: document.id,
      reason: result.reason,
      promptVersion: result.promptVersion,
      durationMs: Date.now() - startedAt,
    };
  }

  const decision = decideChanges({
    document,
    proposal: result.proposal,
    vocab,
    whitelist,
    stateTags: config.stateTags,
    stateTagIds,
    overwrite: config.overwrite,
    maxTitleLength: config.limits.maxTitleLength,
  });

  return {
    kind: "classified",
    documentId: document.id,
    decision,
    proposal: result.proposal,
    usage: result.usage,
    promptVersion: result.promptVersion,
    ocr: {
      chars: ocr.text.length,
      originalChars: ocr.originalLength,
      truncated: ocr.truncated,
    },
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Read-only dry-run orchestration: find one eligible document and classify it.
 * The module contains no write functions.
 */
export async function processOneDocument(
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const { document, candidateCount } = await findEligibleDocument(deps);
  if (document === null) {
    deps.log("info", "no-eligible-document", {
      pendingTagId: deps.stateTagIds.pending,
      candidateCount,
    });
    return { kind: "no-candidate" };
  }
  return classifyDocument(deps, document);
}
