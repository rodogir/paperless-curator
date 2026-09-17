import type { Vocabularies } from "./decision.ts";
import type { Logger } from "./logger.ts";
import { resolveName } from "./metadata.ts";
import {
  createCorrespondent,
  createDocumentType,
  createTag,
  type PaperlessContext,
} from "./paperless.ts";
import type { Whitelist } from "./whitelist.ts";

export type ReconcileKind = "tag" | "correspondent" | "documentType";

export type ReconcileCreation = {
  kind: ReconcileKind;
  name: string;
};

export type ReconciliationPlan = {
  creations: ReconcileCreation[];
  problems: string[];
};

export type ReconcileOutcome =
  | { kind: ReconcileKind; name: string; action: "would-create" }
  | { kind: ReconcileKind; name: string; action: "created"; id: number }
  | { kind: ReconcileKind; name: string; action: "already-present"; id: number }
  | { kind: ReconcileKind; name: string; action: "failed"; reason: string };

export type ReconcileResult = {
  outcomes: ReconcileOutcome[];
  problems: string[];
  vocab: Vocabularies;
};

function kindLabel(kind: ReconcileKind): string {
  return kind === "tag"
    ? "tag"
    : kind === "correspondent"
      ? "correspondent"
      : "document type";
}

/**
 * Pure reconciliation plan: one creation per whitelist entry missing from
 * Paperless. Ambiguous normalized names are reported, never created.
 */
export function planReconciliation(
  whitelist: Whitelist,
  vocab: Vocabularies,
): ReconciliationPlan {
  const creations: ReconcileCreation[] = [];
  const problems: string[] = [];

  const kinds: readonly ReconcileKind[] = [
    "tag",
    "correspondent",
    "documentType",
  ];
  for (const kind of kinds) {
    const entries =
      kind === "tag"
        ? whitelist.tags
        : kind === "correspondent"
          ? whitelist.correspondents
          : whitelist.documentTypes;
    const existing =
      kind === "tag"
        ? vocab.tags
        : kind === "correspondent"
          ? vocab.correspondents
          : vocab.documentTypes;

    for (const entry of entries) {
      const resolution = resolveName(entry.name, existing);
      if (resolution.status === "unknown") {
        creations.push({ kind, name: entry.name });
      } else if (resolution.status === "ambiguous") {
        const ids = resolution.candidates.map((candidate) => candidate.id);
        problems.push(
          `whitelisted ${kindLabel(kind)} "${entry.name}" matches multiple Paperless entries (ids ${ids.join(", ")}); not creating`,
        );
      }
    }
  }

  return { creations, problems };
}

function cloneVocab(vocab: Vocabularies): Vocabularies {
  return {
    tags: [...vocab.tags],
    correspondents: [...vocab.correspondents],
    documentTypes: [...vocab.documentTypes],
  };
}

function createEntity(
  ctx: PaperlessContext,
  creation: ReconcileCreation,
): Promise<{ id: number; name: string }> {
  return creation.kind === "tag"
    ? createTag(ctx, creation.name)
    : creation.kind === "correspondent"
      ? createCorrespondent(ctx, creation.name)
      : createDocumentType(ctx, creation.name);
}

function pushEntity(
  vocab: Vocabularies,
  kind: ReconcileKind,
  entity: { id: number; name: string },
): void {
  if (kind === "tag") {
    vocab.tags.push(entity);
  } else if (kind === "correspondent") {
    vocab.correspondents.push(entity);
  } else {
    vocab.documentTypes.push(entity);
  }
}

function existingEntities(
  vocab: Vocabularies,
  kind: ReconcileKind,
): { id: number; name: string }[] {
  return kind === "tag"
    ? vocab.tags
    : kind === "correspondent"
      ? vocab.correspondents
      : vocab.documentTypes;
}

/**
 * Reconciles the whitelist against Paperless. In dry-run mode it reports what
 * would be created and performs no HTTP mutation. In live mode it creates only
 * whitelisted entries, re-checking by normalized name first so repeated runs
 * are idempotent. A failed creation is logged and does not block the others.
 */
export async function reconcileWhitelist(
  ctx: PaperlessContext,
  whitelist: Whitelist,
  vocab: Vocabularies,
  options: { dryRun: boolean; log: Logger },
): Promise<ReconcileResult> {
  const { dryRun, log } = options;
  const plan = planReconciliation(whitelist, vocab);
  const outcomes: ReconcileOutcome[] = [];
  const updated = cloneVocab(vocab);

  for (const problem of plan.problems) {
    log("warn", "whitelist-reconcile-problem", { problem });
  }

  for (const creation of plan.creations) {
    if (dryRun) {
      outcomes.push({
        kind: creation.kind,
        name: creation.name,
        action: "would-create",
      });
      log("info", "whitelist-entity-would-create", {
        kind: creation.kind,
        name: creation.name,
        dryRun: true,
      });
      continue;
    }

    const recheck = resolveName(
      creation.name,
      existingEntities(updated, creation.kind),
    );
    if (recheck.status === "resolved") {
      outcomes.push({
        kind: creation.kind,
        name: creation.name,
        action: "already-present",
        id: recheck.value.id,
      });
      continue;
    }
    if (recheck.status === "ambiguous") {
      log("warn", "whitelist-reconcile-problem", {
        problem: `${kindLabel(creation.kind)} "${creation.name}" became ambiguous before creation; not creating`,
      });
      continue;
    }

    try {
      const created = await createEntity(ctx, creation);
      pushEntity(updated, creation.kind, created);
      outcomes.push({
        kind: creation.kind,
        name: created.name,
        action: "created",
        id: created.id,
      });
      log("info", "whitelist-entity-created", {
        kind: creation.kind,
        name: created.name,
        id: created.id,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcomes.push({
        kind: creation.kind,
        name: creation.name,
        action: "failed",
        reason,
      });
      log("error", "whitelist-entity-create-failed", {
        kind: creation.kind,
        name: creation.name,
        message: reason,
      });
    }
  }

  return { outcomes, problems: plan.problems, vocab: updated };
}
