import { errorCategory, errorMessage } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { StateTagIds } from "./metadata.ts";
import {
  getDocument,
  listDocumentsWithTag,
  type PaperlessContext,
  updateDocument,
} from "./paperless.ts";
import { buildDocumentUpdate } from "./state.ts";

export type StaleCandidate = {
  id: number;
  tags: readonly number[];
  modified: string;
};

export type StaleEvaluation =
  | { stale: true; ageMs: number }
  | {
      stale: false;
      reason:
        | "missing-processing-tag"
        | "conflicting-state-tags"
        | "unparseable-modified"
        | "not-yet-stale";
      ageMs?: number;
      conflicting?: number[];
    };

/**
 * Pure stale-processing decision. A document is stale only when it carries the
 * processing tag, no other state tag, and a parsable `modified` timestamp older
 * than the threshold. `modified` is a whole-document change time, so it can
 * only prove that nothing has changed recently; see docs/api-notes.md.
 */
export function evaluateStaleProcessing(
  candidate: StaleCandidate,
  stateTagIds: StateTagIds,
  thresholdMs: number,
  nowMs: number,
): StaleEvaluation {
  const present = new Set(candidate.tags);
  if (!present.has(stateTagIds.processing)) {
    return { stale: false, reason: "missing-processing-tag" };
  }

  const conflicting = [
    stateTagIds.pending,
    stateTagIds.processed,
    stateTagIds.review,
    stateTagIds.failed,
  ].filter((id) => present.has(id));
  if (conflicting.length > 0) {
    return { stale: false, reason: "conflicting-state-tags", conflicting };
  }

  const modifiedMs = Date.parse(candidate.modified);
  if (!Number.isFinite(modifiedMs)) {
    return { stale: false, reason: "unparseable-modified" };
  }

  const ageMs = nowMs - modifiedMs;
  if (ageMs < thresholdMs) {
    return { stale: false, reason: "not-yet-stale", ageMs };
  }
  return { stale: true, ageMs };
}

export type StaleRecoveryOutcome = {
  documentId: number;
  action: "would-recover" | "recovered" | "failed";
  ageMs: number;
  reason?: string;
};

export type StaleRecoveryArgs = {
  paperless: PaperlessContext;
  dryRun: boolean;
  stateTagIds: StateTagIds;
  thresholdMs: number;
  nowMs: number;
  log: Logger;
};

/**
 * Recovers documents stranded in `ai-processing` by returning them to
 * `ai-pending`, preserving every non-state tag. Live mode only; dry-run reports
 * what would move and mutates nothing. Each document is independent: one
 * failure is logged and does not block the others or the rest of the cycle.
 */
export async function recoverStaleProcessing(
  args: StaleRecoveryArgs,
): Promise<StaleRecoveryOutcome[]> {
  const { paperless, dryRun, stateTagIds, thresholdMs, nowMs, log } = args;
  const candidates = await listDocumentsWithTag(
    paperless,
    stateTagIds.processing,
  );
  const outcomes: StaleRecoveryOutcome[] = [];

  for (const candidate of candidates) {
    const evaluation = evaluateStaleProcessing(
      candidate,
      stateTagIds,
      thresholdMs,
      nowMs,
    );
    if (!evaluation.stale) {
      if (
        evaluation.reason === "conflicting-state-tags" ||
        evaluation.reason === "unparseable-modified"
      ) {
        log("warn", "stale-processing-skipped", {
          documentId: candidate.id,
          reason: evaluation.reason,
          conflictingStateTagIds: evaluation.conflicting,
        });
      }
      continue;
    }

    if (dryRun) {
      outcomes.push({
        documentId: candidate.id,
        action: "would-recover",
        ageMs: evaluation.ageMs,
      });
      log("info", "stale-processing-would-recover", {
        documentId: candidate.id,
        ageMs: evaluation.ageMs,
        modified: candidate.modified,
        dryRun: true,
      });
      continue;
    }

    try {
      const fresh = await getDocument(paperless, candidate.id);
      const patch = buildDocumentUpdate({
        currentTags: fresh.tags,
        changes: {
          title: null,
          correspondentId: null,
          documentTypeId: null,
          addTagIds: [],
        },
        stateTagIds,
        targetState: "pending",
      });
      if (patch !== null) {
        await updateDocument(paperless, fresh.id, patch);
      }
      outcomes.push({
        documentId: fresh.id,
        action: "recovered",
        ageMs: evaluation.ageMs,
      });
      log("info", "stale-processing-recovered", {
        documentId: fresh.id,
        ageMs: evaluation.ageMs,
        state: "pending",
      });
    } catch (error) {
      const reason = errorMessage(error);
      outcomes.push({
        documentId: candidate.id,
        action: "failed",
        ageMs: evaluation.ageMs,
        reason,
      });
      log("error", "stale-processing-recovery-failed", {
        documentId: candidate.id,
        ageMs: evaluation.ageMs,
        errorCategory: errorCategory(error),
        message: reason,
      });
    }
  }

  return outcomes;
}
