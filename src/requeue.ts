import type { Vocabularies } from "./decision.ts";
import { resolveName } from "./metadata.ts";
import type { ReviewRecord, ReviewStore } from "./review.ts";

export const DEFAULT_REQUEUE_MIN_INTERVAL_MS = 5 * 60_000;

export type RequeueDecision = {
  documentId: number;
  record: ReviewRecord;
};

export type GapCheck = {
  filled: boolean;
  pending: string[];
};

/**
 * A gap is filled only when the missing entity resolves uniquely to an existing
 * Paperless entity. Unknown or ambiguous names are not filled.
 */
export function checkGapsFilled(
  record: ReviewRecord,
  vocab: Vocabularies,
): GapCheck {
  const pending: string[] = [];
  for (const entry of record.missing) {
    const vocabulary =
      entry.kind === "tag"
        ? vocab.tags
        : entry.kind === "correspondent"
          ? vocab.correspondents
          : vocab.documentTypes;
    if (resolveName(entry.name, vocabulary).status !== "resolved") {
      pending.push(`${entry.kind} "${entry.name}"`);
    }
  }
  return { filled: pending.length === 0, pending };
}

/**
 * Pure requeue decision. Only `status: "review"` documents with `requeueable:
 * true` whose gaps are all filled are requeued, and repeated requeues are
 * rate-limited. Returns decisions in ascending document id order.
 */
export function decideRequeues(args: {
  store: ReviewStore;
  vocab: Vocabularies;
  nowMs: number;
  minIntervalMs?: number;
}): RequeueDecision[] {
  const { store, vocab, nowMs } = args;
  const minInterval = args.minIntervalMs ?? DEFAULT_REQUEUE_MIN_INTERVAL_MS;
  const decisions: RequeueDecision[] = [];

  const records = Object.values(store.documents).sort(
    (a, b) => a.documentId - b.documentId,
  );

  for (const record of records) {
    if (record.status !== "review" || !record.requeueable) {
      continue;
    }
    if (record.missing.length === 0) {
      continue;
    }
    if (record.lastRequeueAt !== null) {
      const last = Date.parse(record.lastRequeueAt);
      if (Number.isFinite(last) && nowMs - last < minInterval) {
        continue;
      }
    }
    if (!checkGapsFilled(record, vocab).filled) {
      continue;
    }
    decisions.push({ documentId: record.documentId, record });
  }

  return decisions;
}
