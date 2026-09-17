import { UpstreamError } from "./errors.ts";
import {
  type FetchLike,
  type RetryInfo,
  type RetryPolicy,
  requestJson,
} from "./http.ts";
import { buildMessages, PROMPT_VERSION, type PromptInput } from "./prompt.ts";

export type Proposal = {
  title: string;
  tags: string[];
  correspondent: string | null;
  documentType: string | null;
  review: boolean;
  reviewReasons: string[];
};

export type LlmUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export type LlmCallResult =
  | { ok: true; proposal: Proposal; usage: LlmUsage; promptVersion: string }
  | { ok: false; reason: string; promptVersion: string };

export type LlmContext = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl: FetchLike;
  retry: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
};

export const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "tags",
    "correspondent",
    "document_type",
    "review",
    "review_reasons",
  ],
  properties: {
    title: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    correspondent: { type: ["string", "null"] },
    document_type: { type: ["string", "null"] },
    review: { type: "boolean" },
    review_reasons: { type: "array", items: { type: "string" } },
  },
} as const;

type ProposalParse =
  | { ok: true; value: Proposal }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(
  value: unknown,
  field: string,
  errors: string[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field} must contain only strings`);
      return [];
    }
    result.push(item);
  }
  return result;
}

function readOptionalString(
  value: unknown,
  field: string,
  errors: string[],
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    errors.push(`${field} must be a string or null`);
    return null;
  }
  return value;
}

/**
 * Validates the untrusted model response against the versioned contract.
 */
export function parseProposal(raw: unknown): ProposalParse {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["response is not a JSON object"] };
  }
  const errors: string[] = [];
  const title = typeof raw.title === "string" ? raw.title : null;
  if (title === null) {
    errors.push("title must be a string");
  }
  const tags = readStringArray(raw.tags, "tags", errors);
  const correspondent = readOptionalString(
    raw.correspondent,
    "correspondent",
    errors,
  );
  const documentType = readOptionalString(
    raw.document_type,
    "document_type",
    errors,
  );
  const review = typeof raw.review === "boolean" ? raw.review : null;
  if (review === null) {
    errors.push("review must be a boolean");
  }
  const reviewReasons = readStringArray(
    raw.review_reasons,
    "review_reasons",
    errors,
  );

  if (errors.length > 0 || title === null || review === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      title,
      tags,
      correspondent,
      documentType,
      review,
      reviewReasons,
    },
  };
}

function readUsage(value: unknown): LlmUsage {
  if (!isPlainObject(value)) {
    return { promptTokens: null, completionTokens: null, totalTokens: null };
  }
  const toNumber = (input: unknown): number | null =>
    typeof input === "number" && Number.isFinite(input) ? input : null;
  return {
    promptTokens: toNumber(value.prompt_tokens),
    completionTokens: toNumber(value.completion_tokens),
    totalTokens: toNumber(value.total_tokens),
  };
}

function extractContent(
  raw: unknown,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: "response is not a JSON object" };
  }
  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, reason: "response contained no choices" };
  }
  const first = choices[0];
  if (!isPlainObject(first)) {
    return { ok: false, reason: "response choice was malformed" };
  }
  const message = first.message;
  if (!isPlainObject(message) || typeof message.content !== "string") {
    return { ok: false, reason: "response choice had no text content" };
  }
  if (message.content.trim().length === 0) {
    return { ok: false, reason: "response content was empty" };
  }
  return { ok: true, content: message.content };
}

export function buildRequestBody(model: string, input: PromptInput): string {
  return JSON.stringify({
    model,
    messages: buildMessages(input),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "document_proposal",
        strict: true,
        schema: PROPOSAL_SCHEMA,
      },
    },
    temperature: 0,
  });
}

export async function callModel(
  ctx: LlmContext,
  input: PromptInput,
): Promise<LlmCallResult> {
  const raw = await requestJson({
    source: "llm",
    url: `${ctx.baseUrl}/chat/completions`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      "Content-Type": "application/json",
    },
    body: buildRequestBody(ctx.model, input),
    fetchImpl: ctx.fetchImpl,
    retry: ctx.retry,
    sleep: ctx.sleep,
    onRetry: ctx.onRetry,
  });

  const content = extractContent(raw);
  if (!content.ok) {
    return { ok: false, reason: content.reason, promptVersion: PROMPT_VERSION };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content.content) as unknown;
  } catch {
    return {
      ok: false,
      reason: "model returned text that is not valid JSON",
      promptVersion: PROMPT_VERSION,
    };
  }

  const proposal = parseProposal(parsedJson);
  if (!proposal.ok) {
    return {
      ok: false,
      reason: `model response failed validation: ${proposal.errors.join("; ")}`,
      promptVersion: PROMPT_VERSION,
    };
  }

  const usage = readUsage(isPlainObject(raw) ? raw.usage : undefined);
  return {
    ok: true,
    proposal: proposal.value,
    usage,
    promptVersion: PROMPT_VERSION,
  };
}

export function assertLlmConfigured(ctx: LlmContext): void {
  if (ctx.apiKey.trim().length === 0) {
    throw new UpstreamError("LLM_API_KEY is not set", {
      category: "permanent",
      source: "llm",
    });
  }
}
