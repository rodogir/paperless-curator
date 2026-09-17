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

export type ProcessOutcome =
  | { kind: "no-candidate" }
  | {
      kind: "processed";
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

export async function processOneDocument(
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  const { config, paperless, llm, vocab, whitelist, stateTagIds, log } = deps;

  let selected: DocumentDetail | null = null;
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
    } else {
      selected = detail;
    }
  } else {
    const candidates = await listPendingDocuments(
      paperless,
      stateTagIds.pending,
    );
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
      selected = await getDocument(paperless, candidate.id);
      break;
    }
  }

  if (selected === null) {
    log("info", "no-eligible-document", {
      pendingTagId: stateTagIds.pending,
      candidateCount,
    });
    return { kind: "no-candidate" };
  }

  const startedAt = Date.now();
  const document = selected;

  const ocr = prepareOcr(document.content, config.limits.maxOcrChars);
  if (!ocr.ok) {
    const reviewDecision: Decision = {
      outcome: "review",
      changes: {
        title: null,
        correspondentId: null,
        documentTypeId: null,
        addTagIds: [],
      },
      reviewReasons: [`unusable OCR: ${ocr.reason}`],
      missing: [],
      requeueable: false,
      notes: [],
    };
    const durationMs = Date.now() - startedAt;
    log("warn", "document-review", {
      documentId: document.id,
      reason: `unusable OCR: ${ocr.reason}`,
      durationMs,
      dryRun: config.dryRun,
    });
    return {
      kind: "processed",
      documentId: document.id,
      decision: reviewDecision,
      proposal: null,
      usage: null,
      promptVersion: null,
      ocr: null,
      durationMs,
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

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    log("warn", "model-response-invalid", {
      documentId: document.id,
      reason: result.reason,
      promptVersion: result.promptVersion,
      durationMs,
      dryRun: config.dryRun,
    });
    return {
      kind: "model-invalid",
      documentId: document.id,
      reason: result.reason,
      promptVersion: result.promptVersion,
      durationMs,
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
    kind: "processed",
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
    durationMs,
  };
}
