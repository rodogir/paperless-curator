export const CONFIG_VERSION = 1;

export type StateTagConfig = {
  pending: string;
  processing: string;
  processed: string;
  review: string;
  failed: string;
};

export type AppConfig = {
  version: typeof CONFIG_VERSION;
  paperless: { baseUrl: string };
  llm: { baseUrl: string; model: string };
  stateTags: StateTagConfig;
  dryRun: boolean;
  overwrite: {
    title: boolean;
    correspondent: boolean;
    documentType: boolean;
  };
  limits: { maxTitleLength: number; maxOcrChars: number };
  request: { timeoutMs: number; maxRetries: number; retryBackoffMs: number };
};

export const DEFAULT_CONFIG_PATH = "config.json";

/**
 * Paperless-ngx `title` has max_length 128 in the v3 API schema. Generating a
 * longer title would be rejected by Paperless, so the application limit can
 * never exceed it.
 */
export const PAPERLESS_TITLE_MAX_LENGTH = 128;

export const DEFAULT_STATE_TAGS: StateTagConfig = {
  pending: "ai-pending",
  processing: "ai-processing",
  processed: "ai-processed",
  review: "ai-review",
  failed: "ai-failed",
};

export const DEFAULT_LIMITS = {
  maxTitleLength: PAPERLESS_TITLE_MAX_LENGTH,
  maxOcrChars: 30_000,
};

export const DEFAULT_REQUEST = {
  timeoutMs: 30_000,
  maxRetries: 2,
  retryBackoffMs: 1_000,
};

export function configErrorMessage(path: string, detail: string): string {
  return `invalid configuration at ${path}: ${detail}`;
}

class ConfigValidationError extends Error {
  constructor(path: string, detail: string) {
    super(configErrorMessage(path, detail));
    this.name = "ConfigValidationError";
  }
}

function fail(path: string, detail: string): never {
  throw new ConfigValidationError(path, detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    fail(path, "expected an object");
  }
  return value;
}

function optionalObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  return requireObject(value, path);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback?: string,
): string {
  const value = source[key];
  if (value === undefined) {
    if (fallback !== undefined) {
      return fallback;
    }
    fail(`${path}.${key}`, "is required");
  }
  if (typeof value !== "string") {
    fail(`${path}.${key}`, "expected a string");
  }
  return value;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  const value = source[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    fail(`${path}.${key}`, "expected a boolean");
  }
  return value;
}

function readInt(
  source: Record<string, unknown>,
  key: string,
  path: string,
  options: { fallback?: number; min: number; max: number },
): number {
  const value = source[key];
  if (value === undefined) {
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    fail(`${path}.${key}`, "is required");
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path}.${key}`, "expected an integer");
  }
  if (value < options.min || value > options.max) {
    fail(`${path}.${key}`, `must be between ${options.min} and ${options.max}`);
  }
  return value;
}

function normalizeBaseUrl(value: string, path: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(path, "expected an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail(path, "expected an http or https URL");
  }
  const normalized = parsed.toString().replace(/\/+$/, "");
  return normalized;
}

function readStateTags(
  raw: Record<string, unknown>,
  path: string,
): StateTagConfig {
  const tags = optionalObject(raw.stateTags, path);
  const result: StateTagConfig = {
    pending: readString(tags, "pending", path, DEFAULT_STATE_TAGS.pending),
    processing: readString(
      tags,
      "processing",
      path,
      DEFAULT_STATE_TAGS.processing,
    ),
    processed: readString(
      tags,
      "processed",
      path,
      DEFAULT_STATE_TAGS.processed,
    ),
    review: readString(tags, "review", path, DEFAULT_STATE_TAGS.review),
    failed: readString(tags, "failed", path, DEFAULT_STATE_TAGS.failed),
  };

  const seen = new Map<string, string>();
  for (const [key, name] of Object.entries(result)) {
    if (name.trim().length === 0) {
      fail(`${path}.stateTags.${key}`, "must not be empty");
    }
    const normalized = name.trim().toLowerCase();
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      fail(
        `${path}.stateTags`,
        `state tag names must be distinct; "${name}" is used by both ${previous} and ${key}`,
      );
    }
    seen.set(normalized, key);
  }
  return result;
}

/**
 * Validates untrusted configuration data and applies documented defaults.
 * Throws an Error with an actionable message that never contains secrets.
 */
export function parseConfig(raw: unknown): AppConfig {
  const root = requireObject(raw, "config");

  const version = root.version;
  if (version !== CONFIG_VERSION) {
    fail(
      "config.version",
      `unsupported version ${JSON.stringify(version)}; expected ${CONFIG_VERSION}`,
    );
  }

  const paperless = requireObject(root.paperless, "config.paperless");
  const llm = requireObject(root.llm, "config.llm");
  const overwrite = optionalObject(root.overwrite, "config.overwrite");
  const limits = optionalObject(root.limits, "config.limits");
  const request = optionalObject(root.request, "config.request");

  const config: AppConfig = {
    version: CONFIG_VERSION,
    paperless: {
      baseUrl: normalizeBaseUrl(
        readString(paperless, "baseUrl", "config.paperless"),
        "config.paperless.baseUrl",
      ),
    },
    llm: {
      baseUrl: normalizeBaseUrl(
        readString(llm, "baseUrl", "config.llm"),
        "config.llm.baseUrl",
      ),
      model: readString(llm, "model", "config.llm"),
    },
    stateTags: readStateTags(root, "config"),
    dryRun: readBoolean(root, "dryRun", "config", true),
    overwrite: {
      title: readBoolean(overwrite, "title", "config.overwrite", false),
      correspondent: readBoolean(
        overwrite,
        "correspondent",
        "config.overwrite",
        false,
      ),
      documentType: readBoolean(
        overwrite,
        "documentType",
        "config.overwrite",
        false,
      ),
    },
    limits: {
      maxTitleLength: readInt(limits, "maxTitleLength", "config.limits", {
        fallback: DEFAULT_LIMITS.maxTitleLength,
        min: 1,
        max: PAPERLESS_TITLE_MAX_LENGTH,
      }),
      maxOcrChars: readInt(limits, "maxOcrChars", "config.limits", {
        fallback: DEFAULT_LIMITS.maxOcrChars,
        min: 1,
        max: 10_000_000,
      }),
    },
    request: {
      timeoutMs: readInt(request, "timeoutMs", "config.request", {
        fallback: DEFAULT_REQUEST.timeoutMs,
        min: 1,
        max: 600_000,
      }),
      maxRetries: readInt(request, "maxRetries", "config.request", {
        fallback: DEFAULT_REQUEST.maxRetries,
        min: 0,
        max: 10,
      }),
      retryBackoffMs: readInt(request, "retryBackoffMs", "config.request", {
        fallback: DEFAULT_REQUEST.retryBackoffMs,
        min: 0,
        max: 60_000,
      }),
    },
  };

  if (config.llm.model.trim().length === 0) {
    fail("config.llm.model", "must not be empty");
  }

  return config;
}

export function resolveConfigPath(
  env: Record<string, string | undefined>,
): string {
  const fromEnv = env.CONFIG_PATH;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return DEFAULT_CONFIG_PATH;
}

export async function loadConfig(path: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    throw new Error(
      `unable to read configuration file at ${path}: ${(error as Error).message}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `configuration file at ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }

  return parseConfig(raw);
}
