import type { AppConfig } from "./config.ts";
import {
  type Decision,
  decideChanges,
  type ProposedChanges,
  type Vocabularies,
} from "./decision.ts";
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
};

function nowIsoOf(now: () => Date): string {
  return now().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  // 1. Requeue reviewed documents whose whitelist gaps are now filled.
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
        message: errorMessage(error),
      });
    }
  }

  if (requeues.some((entry) => entry.action === "requeued")) {
    await deps.artifacts.saveMarkdown(renderReviewMarkdown(store));
  }

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

  // 2. Select one eligible document.
  const { document, candidateCount } = await findEligibleDocument(processDeps);
  if (document === null) {
    log("info", "no-eligible-document", {
      pendingTagId: deps.stateTagIds.pending,
      candidateCount,
      dryRun: config.dryRun,
    });
    return {
      outcome: "no-candidate",
      documentId: null,
      decision: null,
      classification: null,
      created: reconciliation.outcomes,
      requeues,
    };
  }

  // 3. Claim the document. A failed claim makes no model request.
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
          message: errorMessage(error),
        });
        return {
          outcome: "claim-failed",
          documentId: document.id,
          decision: null,
          classification: null,
          created: reconciliation.outcomes,
          requeues,
        };
      }
    }
  }

  // 4. Classify.
  let classification: Classification;
  try {
    classification = await classifyDocument(processDeps, document);
  } catch (error) {
    log("error", "document-processing-failed", {
      documentId: document.id,
      message: errorMessage(error),
      dryRun: config.dryRun,
    });
    if (!config.dryRun) {
      await applyFinalState(deps, document, "failed", document.tags);
    }
    return {
      outcome: "failed",
      documentId: document.id,
      decision: null,
      classification: null,
      created: reconciliation.outcomes,
      requeues,
    };
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
    return {
      outcome: "model-invalid",
      documentId: document.id,
      decision,
      classification,
      created: reconciliation.outcomes,
      requeues,
    };
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
    return {
      outcome: "review",
      documentId: document.id,
      decision,
      classification,
      created: reconciliation.outcomes,
      requeues,
    };
  }

  // 5. Apply a successful or no-op outcome.
  if (config.dryRun) {
    log("info", decision.outcome === "update" ? "proposed-update" : "noop", {
      documentId: document.id,
      changes: decision.changes,
      notes: decision.notes,
      dryRun: true,
    });
    return {
      outcome: decision.outcome === "update" ? "updated" : "noop",
      documentId: document.id,
      decision,
      classification,
      created: reconciliation.outcomes,
      requeues,
    };
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
    return {
      outcome: "review",
      documentId: fresh.id,
      decision: finalDecision,
      classification,
      created: reconciliation.outcomes,
      requeues,
    };
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
      message: errorMessage(error),
      action:
        "re-fetch and retry on the next poll; metadata and state are idempotent",
    });
    return {
      outcome: "failed",
      documentId: fresh.id,
      decision: freshDecision,
      classification,
      created: reconciliation.outcomes,
      requeues,
    };
  }

  const existingRecord = store.documents[String(fresh.id)];
  if (existingRecord !== undefined) {
    store = removeReviewRecord(store, fresh.id, nowIsoOf(now));
    await deps.artifacts.save(store);
    await deps.artifacts.saveMarkdown(renderReviewMarkdown(store));
  }

  return {
    outcome: freshDecision.outcome === "update" ? "updated" : "noop",
    documentId: fresh.id,
    decision: freshDecision,
    classification,
    created: reconciliation.outcomes,
    requeues,
  };
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
