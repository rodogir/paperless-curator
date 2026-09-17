import type { Decision, MissingEntity, MissingEntityKind } from "./decision.ts";
import type { Proposal } from "./llm.ts";
import type { DocumentDetail } from "./paperless.ts";

export const REVIEW_STORE_VERSION = 1;

export type ReviewStatus = "review" | "failed";

export type ReviewCurrent = {
  title: string;
  correspondent: string | null;
  documentType: string | null;
  tags: string[];
};

export type ReviewProposal = {
  title: string;
  tags: string[];
  correspondent: string | null;
  documentType: string | null;
};

export type ReviewRecord = {
  documentId: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: ReviewStatus;
  requeueable: boolean;
  attempts: number;
  lastRequeueAt: string | null;
  current: ReviewCurrent;
  proposal: ReviewProposal | null;
  reviewReasons: string[];
  missing: MissingEntity[];
};

export type ReviewStore = {
  version: typeof REVIEW_STORE_VERSION;
  updatedAt: string;
  documents: Record<string, ReviewRecord>;
};

export type ReviewLogEntry = {
  ts: string;
  documentId: number;
  status: ReviewStatus;
  requeueable: boolean;
  attempts: number;
  reviewReasons: string[];
  missing: MissingEntity[];
};

export function emptyReviewStore(now: string): ReviewStore {
  return { version: REVIEW_STORE_VERSION, updatedAt: now, documents: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readMissing(value: unknown): MissingEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kinds: readonly MissingEntityKind[] = [
    "tag",
    "correspondent",
    "documentType",
  ];
  const result: MissingEntity[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      continue;
    }
    const kind = item.kind;
    const name = item.name;
    const reason = item.reason;
    if (
      typeof kind === "string" &&
      (kinds as readonly string[]).includes(kind) &&
      typeof name === "string" &&
      typeof reason === "string"
    ) {
      result.push({ kind: kind as MissingEntityKind, name, reason });
    }
  }
  return result;
}

function parseRecord(value: unknown): ReviewRecord | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const documentId = value.documentId;
  if (typeof documentId !== "number" || !Number.isInteger(documentId)) {
    return null;
  }
  const status = value.status === "failed" ? "failed" : "review";
  const current = isPlainObject(value.current) ? value.current : {};
  const proposal = isPlainObject(value.proposal)
    ? {
        title:
          typeof value.proposal.title === "string" ? value.proposal.title : "",
        tags: readStringArray(value.proposal.tags),
        correspondent:
          typeof value.proposal.correspondent === "string"
            ? value.proposal.correspondent
            : null,
        documentType:
          typeof value.proposal.document_type === "string"
            ? value.proposal.document_type
            : null,
      }
    : null;
  return {
    documentId,
    firstSeenAt: typeof value.firstSeenAt === "string" ? value.firstSeenAt : "",
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : "",
    status,
    requeueable: value.requeueable === true,
    attempts:
      typeof value.attempts === "number" && Number.isInteger(value.attempts)
        ? value.attempts
        : 1,
    lastRequeueAt:
      typeof value.lastRequeueAt === "string" ? value.lastRequeueAt : null,
    current: {
      title: typeof current.title === "string" ? current.title : "",
      correspondent:
        typeof current.correspondent === "string"
          ? current.correspondent
          : null,
      documentType:
        typeof current.document_type === "string"
          ? current.document_type
          : null,
      tags: readStringArray(current.tags),
    },
    proposal,
    reviewReasons: readStringArray(value.reviewReasons),
    missing: readMissing(value.missing),
  };
}

export function parseReviewStore(raw: unknown): ReviewStore {
  if (!isPlainObject(raw)) {
    throw new Error("review store is not a JSON object");
  }
  if (raw.version !== REVIEW_STORE_VERSION) {
    throw new Error(
      `unsupported review store version ${JSON.stringify(raw.version)}; expected ${REVIEW_STORE_VERSION}`,
    );
  }
  const documents: Record<string, ReviewRecord> = {};
  if (isPlainObject(raw.documents)) {
    for (const [key, value] of Object.entries(raw.documents)) {
      const record = parseRecord(value);
      if (record !== null) {
        documents[key] = record;
      }
    }
  }
  return {
    version: REVIEW_STORE_VERSION,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    documents,
  };
}

export type BuildReviewRecordArgs = {
  document: DocumentDetail;
  proposal: Proposal | null;
  decision: Decision;
  status: ReviewStatus;
  tagNames: Map<number, string>;
  correspondentNames: Map<number, string>;
  documentTypeNames: Map<number, string>;
  stateTagIds?: readonly number[];
  now: string;
  existing?: ReviewRecord;
};

/**
 * Builds a review record from already-resolved decision data. Stores derived
 * metadata only; never OCR text.
 */
export function buildReviewRecord(args: BuildReviewRecordArgs): ReviewRecord {
  const {
    document,
    proposal,
    decision,
    status,
    tagNames,
    correspondentNames,
    documentTypeNames,
    now,
    existing,
  } = args;

  const stateTags = new Set(args.stateTagIds ?? []);
  const currentTags = document.tags
    .filter((id) => !stateTags.has(id))
    .map((id) => tagNames.get(id))
    .filter((name): name is string => name !== undefined);

  return {
    documentId: document.id,
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    status,
    requeueable: decision.requeueable,
    attempts: existing?.attempts ?? 1,
    lastRequeueAt: existing?.lastRequeueAt ?? null,
    current: {
      title: document.title,
      correspondent:
        document.correspondent === null
          ? null
          : (correspondentNames.get(document.correspondent) ?? null),
      documentType:
        document.documentType === null
          ? null
          : (documentTypeNames.get(document.documentType) ?? null),
      tags: currentTags,
    },
    proposal:
      proposal === null
        ? null
        : {
            title: proposal.title,
            tags: [...proposal.tags],
            correspondent: proposal.correspondent,
            documentType: proposal.documentType,
          },
    reviewReasons: [...decision.reviewReasons],
    missing: decision.missing.map((entry) => ({ ...entry })),
  };
}

export function upsertReviewRecord(
  store: ReviewStore,
  record: ReviewRecord,
  now: string,
): ReviewStore {
  return {
    version: REVIEW_STORE_VERSION,
    updatedAt: now,
    documents: { ...store.documents, [String(record.documentId)]: record },
  };
}

export function removeReviewRecord(
  store: ReviewStore,
  documentId: number,
  now: string,
): ReviewStore {
  const documents = { ...store.documents };
  delete documents[String(documentId)];
  return { version: REVIEW_STORE_VERSION, updatedAt: now, documents };
}

export function markRequeued(record: ReviewRecord, now: string): ReviewRecord {
  return {
    ...record,
    attempts: record.attempts + 1,
    lastRequeueAt: now,
    lastSeenAt: now,
  };
}

export function buildReviewLogEntry(
  record: ReviewRecord,
  ts: string,
): ReviewLogEntry {
  return {
    ts,
    documentId: record.documentId,
    status: record.status,
    requeueable: record.requeueable,
    attempts: record.attempts,
    reviewReasons: [...record.reviewReasons],
    missing: record.missing.map((entry) => ({ ...entry })),
  };
}

export type SuggestionAggregate = {
  kind: MissingEntityKind;
  name: string;
  documentIds: number[];
  reason: string;
};

function kindRank(kind: MissingEntityKind): number {
  return kind === "tag" ? 0 : kind === "correspondent" ? 1 : 2;
}

/**
 * Aggregates missing entities across review records by kind and normalized
 * name. Deterministic: documents sorted by id, suggestions by kind then name.
 */
export function aggregateSuggestions(
  store: ReviewStore,
): SuggestionAggregate[] {
  const records = Object.values(store.documents).sort(
    (a, b) => a.documentId - b.documentId,
  );
  const groups = new Map<
    string,
    {
      kind: MissingEntityKind;
      name: string;
      ids: Set<number>;
      reasons: string[];
    }
  >();

  for (const record of records) {
    if (record.status !== "review") {
      continue;
    }
    for (const entry of record.missing) {
      if (entry.name.trim().length === 0) {
        continue;
      }
      const key = `${entry.kind}|${entry.name.trim().toLowerCase()}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          kind: entry.kind,
          name: entry.name.trim(),
          ids: new Set([record.documentId]),
          reasons: entry.reason.trim().length > 0 ? [entry.reason.trim()] : [],
        });
      } else {
        existing.ids.add(record.documentId);
        if (
          entry.reason.trim().length > 0 &&
          !existing.reasons.includes(entry.reason.trim())
        ) {
          existing.reasons.push(entry.reason.trim());
        }
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      kind: group.kind,
      name: group.name,
      documentIds: [...group.ids].sort((a, b) => a - b),
      reason: group.reasons.join("; "),
    }))
    .sort((a, b) => {
      const rank = kindRank(a.kind) - kindRank(b.kind);
      return rank !== 0 ? rank : a.name.localeCompare(b.name);
    });
}

export function renderReviewMarkdown(store: ReviewStore): string {
  const lines: string[] = ["# Paperless Curator Review", ""];
  lines.push(`Updated: ${store.updatedAt || "(unknown)"}`, "");

  const suggestions = aggregateSuggestions(store);
  lines.push("## Suggested additions (not yet whitelisted)", "");
  if (suggestions.length === 0) {
    lines.push("None.", "");
  } else {
    for (const suggestion of suggestions) {
      const count = suggestion.documentIds.length;
      const reason =
        suggestion.reason.length > 0 ? ` — "${suggestion.reason}"` : "";
      lines.push(
        `- ${suggestion.kind} "${suggestion.name}" — ${count} doc${count === 1 ? "" : "s"}${reason}`,
      );
      lines.push(`  ${suggestion.documentIds.join(", ")}`);
    }
    lines.push("");
  }

  const records = Object.values(store.documents).sort(
    (a, b) => a.documentId - b.documentId,
  );
  lines.push("## Documents", "");
  if (records.length === 0) {
    lines.push("None.", "");
  }
  for (const record of records) {
    const flags = [
      record.status,
      record.requeueable ? "requeueable" : "not requeueable",
      `attempts ${record.attempts}`,
    ].join(", ");
    lines.push(`### Document ${record.documentId} (${flags})`, "");
    lines.push(`- Last seen: ${record.lastSeenAt || "(unknown)"}`);
    if (record.reviewReasons.length > 0) {
      lines.push(`- Reasons: ${record.reviewReasons.join("; ")}`);
    }
    if (record.missing.length > 0) {
      lines.push(
        `- Missing: ${record.missing
          .map((entry) => `${entry.kind} "${entry.name}" (${entry.reason})`)
          .join("; ")}`,
      );
    }
    const proposal = record.proposal;
    if (proposal !== null) {
      lines.push(`- Proposed title: ${proposal.title || "(none)"}`);
      lines.push(
        `- Proposed tags: ${proposal.tags.length > 0 ? proposal.tags.join(", ") : "(none)"}`,
      );
      lines.push(
        `- Proposed correspondent: ${proposal.correspondent ?? "(none)"}`,
      );
      lines.push(
        `- Proposed document type: ${proposal.documentType ?? "(none)"}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function loadReviewStore(
  path: string,
  now: string,
): Promise<ReviewStore> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyReviewStore(now);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text()) as unknown;
  } catch (error) {
    throw new Error(
      `review store at ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }
  return parseReviewStore(raw);
}

export async function saveReviewStore(
  path: string,
  store: ReviewStore,
): Promise<void> {
  await Bun.write(path, `${JSON.stringify(store, null, 2)}\n`);
}

export async function appendReviewLog(
  path: string,
  entry: ReviewLogEntry,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export type ReviewArtifactPaths = {
  store: string;
  markdown: string;
  log: string;
};

export type ReviewArtifacts = {
  load(): Promise<ReviewStore>;
  save(store: ReviewStore): Promise<void>;
  saveMarkdown(markdown: string): Promise<void>;
  append(entry: ReviewLogEntry): Promise<void>;
};

export function fileReviewArtifacts(
  paths: ReviewArtifactPaths,
  now: () => string,
): ReviewArtifacts {
  return {
    load: () => loadReviewStore(paths.store, now()),
    save: (store) => saveReviewStore(paths.store, store),
    saveMarkdown: async (markdown) => {
      await Bun.write(paths.markdown, markdown);
    },
    append: (entry) => appendReviewLog(paths.log, entry),
  };
}

export type MemoryReviewArtifacts = ReviewArtifacts & {
  getStore(): ReviewStore;
  getMarkdown(): string;
  getLog(): ReviewLogEntry[];
};

export function memoryReviewArtifacts(
  now: () => string,
  initial?: ReviewStore,
): MemoryReviewArtifacts {
  let store = initial ?? emptyReviewStore(now());
  let markdown = "";
  const log: ReviewLogEntry[] = [];
  return {
    load: async () => store,
    save: async (next) => {
      store = next;
    },
    saveMarkdown: async (next) => {
      markdown = next;
    },
    append: async (entry) => {
      log.push(entry);
    },
    getStore: () => store,
    getMarkdown: () => markdown,
    getLog: () => log,
  };
}
