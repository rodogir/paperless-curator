import { UpstreamError } from "./errors.ts";
import {
  requestJson,
  type FetchLike,
  type RetryInfo,
  type RetryPolicy,
} from "./http.ts";
import type { NamedEntity, StateTagIds } from "./metadata.ts";

export type Tag = NamedEntity;
export type Correspondent = NamedEntity;
export type DocumentType = NamedEntity;

export type DocumentSummary = {
  id: number;
  title: string;
  tags: number[];
  correspondent: number | null;
  documentType: number | null;
  created: string;
};

export type DocumentDetail = DocumentSummary & {
  content: string;
  modified: string;
};

export type PaperlessContext = {
  baseUrl: string;
  token: string;
  fetchImpl: FetchLike;
  retry: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
};

const PAGE_SIZE = 100;
const MAX_PAGES = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function headers(ctx: PaperlessContext): Record<string, string> {
  return {
    Authorization: `Token ${ctx.token}`,
    Accept: "application/json",
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function getJson(ctx: PaperlessContext, url: string): Promise<unknown> {
  return requestJson({
    source: "paperless",
    url,
    method: "GET",
    headers: headers(ctx),
    fetchImpl: ctx.fetchImpl,
    retry: ctx.retry,
    sleep: ctx.sleep,
    onRetry: ctx.onRetry,
  });
}

export async function getStatus(
  ctx: PaperlessContext,
): Promise<{ version: string }> {
  const raw = await getJson(ctx, buildUrl(ctx.baseUrl, "/api/status/"));
  if (!isPlainObject(raw)) {
    throw new UpstreamError("unexpected status response", {
      category: "permanent",
      source: "paperless",
    });
  }
  const version = asString(raw.pngx_version);
  if (version === null) {
    throw new UpstreamError("status response missing pngx_version", {
      category: "permanent",
      source: "paperless",
    });
  }
  return { version };
}

function parseNamedEntity(value: unknown): NamedEntity {
  if (!isPlainObject(value)) {
    throw new UpstreamError("vocabulary entry is not an object", {
      category: "permanent",
      source: "paperless",
    });
  }
  const id = asInt(value.id);
  const name = asString(value.name);
  if (id === null || name === null) {
    throw new UpstreamError("vocabulary entry missing id or name", {
      category: "permanent",
      source: "paperless",
    });
  }
  return { id, name };
}

async function listAll<T>(
  ctx: PaperlessContext,
  path: string,
  parseItem: (value: unknown) => T,
  extraQuery: Record<string, string | number | undefined> = {},
): Promise<T[]> {
  let url: string | null = buildUrl(ctx.baseUrl, path, {
    page_size: PAGE_SIZE,
    ...extraQuery,
  });
  const items: T[] = [];

  for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
    const raw = await getJson(ctx, url);
    if (!isPlainObject(raw) || !Array.isArray(raw.results)) {
      throw new UpstreamError("paginated response missing results array", {
        category: "permanent",
        source: "paperless",
      });
    }
    for (const item of raw.results) {
      items.push(parseItem(item));
    }
    url = asString(raw.next);
  }

  return items;
}

export function listTags(ctx: PaperlessContext): Promise<Tag[]> {
  return listAll(ctx, "/api/tags/", parseNamedEntity);
}

export function listCorrespondents(
  ctx: PaperlessContext,
): Promise<Correspondent[]> {
  return listAll(ctx, "/api/correspondents/", parseNamedEntity);
}

export function listDocumentTypes(
  ctx: PaperlessContext,
): Promise<DocumentType[]> {
  return listAll(ctx, "/api/document_types/", parseNamedEntity);
}

function parseDocumentSummary(value: unknown): DocumentSummary {
  if (!isPlainObject(value)) {
    throw new UpstreamError("document entry is not an object", {
      category: "permanent",
      source: "paperless",
    });
  }
  const id = asInt(value.id);
  const title = asString(value.title) ?? "";
  const created = asString(value.created) ?? "";
  if (id === null) {
    throw new UpstreamError("document entry missing id", {
      category: "permanent",
      source: "paperless",
    });
  }
  const tags = Array.isArray(value.tags)
    ? value.tags.map((tag) => asInt(tag) ?? -1).filter((tag) => tag >= 0)
    : [];
  return {
    id,
    title,
    tags,
    correspondent: asInt(value.correspondent),
    documentType: asInt(value.document_type),
    created,
  };
}

/**
 * Lists documents carrying the pending tag, in stable id order. Callers must
 * still verify eligibility locally because the API filter cannot detect
 * conflicting state tags reliably across pagination.
 */
export function listPendingDocuments(
  ctx: PaperlessContext,
  pendingTagId: number,
): Promise<DocumentSummary[]> {
  return listAll(ctx, "/api/documents/", parseDocumentSummary, {
    tags__id__all: pendingTagId,
    ordering: "id",
    fields: "id,title,tags,correspondent,document_type,created",
  });
}

export async function getDocument(
  ctx: PaperlessContext,
  id: number,
): Promise<DocumentDetail> {
  const raw = await getJson(
    ctx,
    buildUrl(ctx.baseUrl, `/api/documents/${id}/`),
  );
  const summary = parseDocumentSummary(raw);
  const content = isPlainObject(raw) ? asString(raw.content) : null;
  const modified = isPlainObject(raw) ? asString(raw.modified) : null;
  return {
    ...summary,
    content: content ?? "",
    modified: modified ?? "",
  };
}

/**
 * Eligibility is a pure, local decision: a document must carry the pending
 * tag and none of the other configured state tags.
 */
export type Eligibility =
  | { eligible: true }
  | { eligible: false; reason: "conflicting-state-tags"; conflicting: number[] }
  | { eligible: false; reason: "missing-pending-tag" };

export function checkEligibility(
  tags: readonly number[],
  stateTagIds: StateTagIds,
): Eligibility {
  const present = new Set(tags);
  const pending = stateTagIds.pending;
  if (!present.has(pending)) {
    return { eligible: false, reason: "missing-pending-tag" };
  }
  const conflicting = [
    stateTagIds.processing,
    stateTagIds.processed,
    stateTagIds.review,
    stateTagIds.failed,
  ].filter((id) => present.has(id));
  if (conflicting.length > 0) {
    return { eligible: false, reason: "conflicting-state-tags", conflicting };
  }
  return { eligible: true };
}
