import type { AppConfig } from "./config.ts";
import {
  type Decision,
  decideChanges,
  type ProposedChanges,
  type Vocabularies,
} from "./decision.ts";
import { errorCategory, errorMessage } from "./errors.ts";
import type { LlmContext, Proposal } from "./llm.ts";
import type { Logger } from "./logger.ts";
import { allStateTagIds, type StateTagIds } from "./metadata.ts";
import {
  type DocumentDetail,
  getDocument,
  type PaperlessContext,
  updateDocument,
} from "./paperless.ts";
import {
  type Classification,
  classifyDocument,
  findEligibleDocument,
  type ProcessDeps,
} from "./process.ts";
import { type ReconcileOutcome, reconcileWhitelist } from "./reconcile.ts";
import { decideRequeues } from "./requeue.ts";
import {
  buildReviewLogEntry,
  buildReviewRecord,
  markRequeued,
  type ReviewArtifacts,
  type ReviewRecord,
  type ReviewStore,
  removeReviewRecord,
  renderReviewMarkdown,
  upsertReviewRecord,
} from "./review.ts";
import { recoverStaleProcessing, type StaleRecoveryOutcome } from "./stale.ts";
import { buildDocumentUpdate, type StateRole } from "./state.ts";
import { isBlank } from "./text.ts";
import type { Whitelist } from "./whitelist.ts";

const NO_CHANGES: ProposedChanges = {
  title: null,
  correspondentId: null,
  documentTypeId: null,
  addTagIds: [],
};

export type RunDeps = {
  config: AppConfig;
  paperless: PaperlessContext;
  llm: LlmContext;
  log: Logger;
  whitelist: Whitelist;
  vocab: Vocabularies;
  stateTagIds: StateTagIds;
  artifacts: ReviewArtifacts;
  now?: () => Date;
  targetDocumentId?: number;
  requeueMinIntervalMs?: number;
};

export type RequeueResult = {
  documentId: number;
  action: "requeued" | "would-requeue" | "failed";
};

export type CycleOutcome =
  | "no-candidate"
  | "claim-failed"
  | "noop"
  | "updated"
  | "review"
  | "model-invalid"
  | "failed";

export type CycleResult = {
  outcome: CycleOutcome;
  documentId: number | null;
  decision: Decision | null;
  classification: Classification | null;
  created: ReconcileOutcome[];
  requeues: RequeueResult[];
  staleRecoveries: StaleRecoveryOutcome[];
};

function nowIsoOf(now: () => Date): string {
  return now().toISOString();
}

function nameMaps(vocab: Vocabularies): {
  tagNames: Map<number, string>;
  correspondentNames: Map<number, string>;
  documentTypeNames: Map<number, string>;
} {
  return {
    tagNames: new Map(vocab.tags.map((entry) => [entry.id, entry.name])),
    correspondentNames: new Map(
      vocab.correspondents.map((entry) => [entry.id, entry.name]),
    ),
    documentTypeNames: new Map(
      vocab.documentTypes.map((entry) => [entry.id, entry.name]),
    ),
  };
}

/**
 * Flags a protected field that was empty at classification time and became
 * populated by something else before the write. Such a conflict routes to
 * review instead of overwriting the new value.
 */
function findProtectedConflict(
  before: DocumentDetail,
  after: DocumentDetail,
  changes: ProposedChanges,
): string | null {
  if (
    isBlank(before.title) &&
    !isBlank(after.title) &&
    changes.title !== null &&
    changes.title !== after.title.trim()
  ) {
    return `title was populated as "${after.title}" after classification`;
  }
  if (
    before.correspondent === null &&
    after.correspondent !== null &&
    changes.correspondentId !== null &&
    changes.correspondentId !== after.correspondent
  ) {
    return "correspondent was populated after classification";
  }
  if (
    before.documentType === null &&
    after.documentType !== null &&
    changes.documentTypeId !== null &&
    changes.documentTypeId !== after.documentType
  ) {
    return "document type was populated after classification";
  }
  return null;
}

function buildReviewDecision(reason: string): Decision {
  return {
    outcome: "review",
    changes: NO_CHANGES,
    reviewReasons: [reason],
    missing: [],
    requeueable: false,
    notes: [],
  };
}

export async function runCycle(deps: RunDeps): Promise<CycleResult> {
  const { config, paperless, log } = deps;
  const now = deps.now ?? (() => new Date());

  const reconciliation = await reconcileWhitelist(
    paperless,
    deps.whitelist,
    deps.vocab,
    { dryRun: config.dryRun, log },
  );
  const vocab = reconciliation.vocab;
  const maps = nameMaps(vocab);

  let store = await deps.artifacts.load();

  const recordReview = async (
    document: DocumentDetail,
    proposal: Proposal | null,
    decision: Decision,
    status: "review" | "failed",
  ): Promise<ReviewStore> => {
    const existing: ReviewRecord | undefined =
      store.documents[String(document.id)];
    const record = buildReviewRecord({
      document,
      proposal,
      decision,
      status,
      ...maps,
      stateTagIds: allStateTagIds(deps.stateTagIds),
      now: nowIsoOf(now),
      existing,
    });
    const next = upsertReviewRecord(store, record, nowIsoOf(now));
    await deps.artifacts.save(next);
    await deps.artifacts.saveMarkdown(renderReviewMarkdown(next));
    await deps.artifacts.append(buildReviewLogEntry(record, nowIsoOf(now)));
    return next;
  };

  // 1. Recover documents stranded in ai-processing past the threshold. Live
  // mode only; idempotent; preserves all non-state tags.
  const staleRecoveries = await recoverStaleProcessing({
    paperless,
    dryRun: config.dryRun,
    stateTagIds: deps.stateTagIds,
    thresholdMs: config.operations.staleProcessingThresholdMs,
    nowMs: now().getTime(),
    log,
  });

  // 2. Requeue reviewed documents whose whitelist gaps are now filled.
  const requeues: RequeueResult[] = [];
  const requeueDecisions = decideRequeues({
    store,
    vocab,
    nowMs: now().getTime(),
    minIntervalMs: deps.requeueMinIntervalMs,
  });
  for (const decision of requeueDecisions) {
    if (config.dryRun) {
      log("info", "review-would-requeue", {
        documentId: decision.documentId,
        dryRun: true,
      });
      requeues.push({
        documentId: decision.documentId,
        action: "would-requeue",
      });
      continue;
    }
    try {
      const current = await getDocument(paperless, decision.documentId);
      const patch = buildDocumentUpdate({
        currentTags: current.tags,
        changes: NO_CHANGES,
        stateTagIds: deps.stateTagIds,
        targetState: "pending",
      });
      if (patch !== null) {
        await updateDocument(paperless, decision.documentId, patch);
      }
      const updated = markRequeued(decision.record, nowIsoOf(now));
      store = upsertReviewRecord(store, updated, nowIsoOf(now));
      await deps.artifacts.save(store);
      requeues.push({ documentId: decision.documentId, action: "requeued" });
      log("info", "review-requeued", {
        documentId: decision.documentId,
        attempts: updated.attempts,
      });
    } catch (error) {
      requeues.push({ documentId: decision.documentId, action: "failed" });
      log("error", "review-requeue-failed", {
        documentId: decision.documentId,
        errorCategory: errorCategory(error),
        message: errorMessage(error),
      });
    }
  }

  if (requeues.some((entry) => entry.action === "requeued")) {
    await deps.artifacts.saveMarkdown(renderReviewMarkdown(store));
  }

  const makeResult = (
    outcome: CycleOutcome,
    documentId: number | null,
    decision: Decision | null,
    classification: Classification | null,
  ): CycleResult => ({
    outcome,
    documentId,
    decision,
    classification,
    created: reconciliation.outcomes,
    requeues,
    staleRecoveries,
  });

  const processDeps: ProcessDeps = {
    config,
    paperless,
    llm: deps.llm,
    vocab,
    whitelist: deps.whitelist,
    stateTagIds: deps.stateTagIds,
    log,
    targetDocumentId: deps.targetDocumentId,
  };

  // 3. Select one eligible document.
  const { document, candidateCount } = await findEligibleDocument(processDeps);
  if (document === null) {
    log("info", "no-eligible-document", {
      pendingTagId: deps.stateTagIds.pending,
      candidateCount,
      dryRun: config.dryRun,
    });
    return makeResult("no-candidate", null, null, null);
  }

  // 4. Claim the document. A failed claim makes no model request.
  if (!config.dryRun) {
    const claim = buildDocumentUpdate({
      currentTags: document.tags,
      changes: NO_CHANGES,
      stateTagIds: deps.stateTagIds,
      targetState: "processing",
    });
    if (claim !== null) {
      try {
        await updateDocument(paperless, document.id, claim);
        log("info", "document-claimed", { documentId: document.id });
      } catch (error) {
        log("error", "document-claim-failed", {
          documentId: document.id,
          errorCategory: errorCategory(error),
          message: errorMessage(error),
        });
        return makeResult("claim-failed", document.id, null, null);
      }
    }
  }

  // 5. Classify.
  let classification: Classification;
  try {
    classification = await classifyDocument(processDeps, document);
  } catch (error) {
    log("error", "document-processing-failed", {
      documentId: document.id,
      errorCategory: errorCategory(error),
      message: errorMessage(error),
      dryRun: config.dryRun,
    });
    if (!config.dryRun) {
      await applyFinalState(deps, document, "failed", document.tags);
    }
    return makeResult("failed", document.id, null, null);
  }

  if (classification.kind === "model-invalid") {
    log("warn", "model-response-invalid", {
      documentId: document.id,
      reason: classification.reason,
      promptVersion: classification.promptVersion,
      durationMs: classification.durationMs,
      dryRun: config.dryRun,
    });
    const decision = buildReviewDecision(
      `invalid model output: ${classification.reason}`,
    );
    if (!config.dryRun) {
      store = await recordReview(document, null, decision, "review");
      await applyFinalState(deps, document, "review", document.tags);
    }
    return makeResult("model-invalid", document.id, decision, classification);
  }

  const decision = classification.decision;

  if (decision.outcome === "review") {
    log("warn", "document-review", {
      documentId: document.id,
      reviewReasons: decision.reviewReasons,
      requeueable: decision.requeueable,
      durationMs: classification.durationMs,
      dryRun: config.dryRun,
    });
    if (!config.dryRun) {
      store = await recordReview(
        document,
        classification.proposal,
        decision,
        "review",
      );
      await applyFinalState(deps, document, "review", document.tags);
    }
    return makeResult("review", document.id, decision, classification);
  }

  // 6. Apply a successful or no-op outcome.
  if (config.dryRun) {
    log("info", decision.outcome === "update" ? "proposed-update" : "noop", {
      documentId: document.id,
      changes: decision.changes,
      notes: decision.notes,
      dryRun: true,
    });
    return makeResult(
      decision.outcome === "update" ? "updated" : "noop",
      document.id,
      decision,
      classification,
    );
  }

  const fresh = await getDocument(paperless, document.id);
  const freshDecision = recomputeDecision(deps, vocab, fresh, classification);
  const conflict = findProtectedConflict(
    document,
    fresh,
    freshDecision.changes,
  );
  if (freshDecision.outcome === "review" || conflict !== null) {
    const finalDecision =
      freshDecision.outcome === "review"
        ? freshDecision
        : buildReviewDecision(conflict ?? "conflicting update");
    log("warn", "document-review", {
      documentId: fresh.id,
      reviewReasons: finalDecision.reviewReasons,
      requeueable: finalDecision.requeueable,
    });
    store = await recordReview(
      fresh,
      classification.proposal,
      finalDecision,
      "review",
    );
    await applyFinalState(deps, fresh, "review", fresh.tags);
    return makeResult("review", fresh.id, finalDecision, classification);
  }

  const patch = buildDocumentUpdate({
    currentTags: fresh.tags,
    changes: freshDecision.changes,
    stateTagIds: deps.stateTagIds,
    targetState: "processed",
  });

  try {
    if (patch !== null) {
      await updateDocument(paperless, fresh.id, patch);
      log("info", "document-metadata-applied", {
        documentId: fresh.id,
        metadata:
          patch.title !== undefined ||
          patch.correspondent !== undefined ||
          patch.document_type !== undefined,
      });
      log("info", "document-state-applied", {
        documentId: fresh.id,
        state: "processed",
      });
    } else {
      log("info", "document-noop", { documentId: fresh.id });
    }
  } catch (error) {
    log("error", "document-update-failed", {
      documentId: fresh.id,
      errorCategory: errorCategory(error),
      message: errorMessage(error),
      action:
        "re-fetch and retry on the next poll; metadata and state are idempotent",
    });
    return makeResult("failed", fresh.id, freshDecision, classification);
  }

  const existingRecord = store.documents[String(fresh.id)];
  if (existingRecord !== undefined) {
    store = removeReviewRecord(store, fresh.id, nowIsoOf(now));
    await deps.artifacts.save(store);
    await deps.artifacts.saveMarkdown(renderReviewMarkdown(store));
  }

  return makeResult(
    freshDecision.outcome === "update" ? "updated" : "noop",
    fresh.id,
    freshDecision,
    classification,
  );
}

function recomputeDecision(
  deps: RunDeps,
  vocab: Vocabularies,
  fresh: DocumentDetail,
  classification: Extract<Classification, { kind: "classified" }>,
): Decision {
  // Recompute against the freshly fetched document so newly observed metadata
  // and tags are respected, using the reconciled vocabulary. Uses the same
  // proposal; OCR is not re-run.
  const proposal = classification.proposal;
  if (proposal === null) {
    return classification.decision;
  }
  return decideChanges({
    document: fresh,
    proposal,
    vocab,
    whitelist: deps.whitelist,
    stateTags: deps.config.stateTags,
    stateTagIds: deps.stateTagIds,
    overwrite: deps.config.overwrite,
    maxTitleLength: deps.config.limits.maxTitleLength,
  });
}

async function applyFinalState(
  deps: RunDeps,
  document: DocumentDetail,
  state: StateRole,
  currentTags: readonly number[],
): Promise<void> {
  try {
    const patch = buildDocumentUpdate({
      currentTags,
      changes: NO_CHANGES,
      stateTagIds: deps.stateTagIds,
      targetState: state,
    });
    if (patch !== null) {
      await updateDocument(deps.paperless, document.id, patch);
      logStateApplied(deps, document.id, state);
    }
  } catch (error) {
    deps.log("error", "state-transition-failed", {
      documentId: document.id,
      state,
      errorCategory: errorCategory(error),
      message: errorMessage(error),
    });
  }
}

function logStateApplied(
  deps: RunDeps,
  documentId: number,
  state: StateRole,
): void {
  deps.log("info", "document-state-applied", { documentId, state });
}
