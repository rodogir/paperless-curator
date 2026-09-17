import type { StateTagConfig } from "./config.ts";
import { normalizeName } from "./metadata.ts";

export const WHITELIST_VERSION = 1;

export type WhitelistNamespace = "tags" | "correspondents" | "documentTypes";

export type WhitelistEntry = {
  name: string;
  aliases: string[];
  description: string | null;
};

export type Whitelist = {
  version: typeof WHITELIST_VERSION;
  tags: WhitelistEntry[];
  correspondents: WhitelistEntry[];
  documentTypes: WhitelistEntry[];
};

const NAMESPACES: readonly WhitelistNamespace[] = [
  "tags",
  "correspondents",
  "documentTypes",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WhitelistValidationError extends Error {
  constructor(path: string, detail: string) {
    super(`invalid whitelist at ${path}: ${detail}`);
    this.name = "WhitelistValidationError";
  }
}

function fail(path: string, detail: string): never {
  throw new WhitelistValidationError(path, detail);
}

function readRequiredName(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "expected a string");
  }
  const name = value.trim();
  if (name.length === 0) {
    fail(path, "must not be empty");
  }
  return name;
}

function readAliases(value: unknown, path: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(path, "expected an array of strings");
  }
  return value.map((alias, index) =>
    readRequiredName(alias, `${path}[${index}]`),
  );
}

function readDescription(value: unknown, path: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    fail(path, "expected a string");
  }
  const description = value.trim();
  if (description.length === 0) {
    fail(path, "must not be empty when present");
  }
  return description;
}

function parseEntry(value: unknown, path: string): WhitelistEntry {
  if (!isPlainObject(value)) {
    fail(path, "expected an object");
  }
  return {
    name: readRequiredName(value.name, `${path}.name`),
    aliases: readAliases(value.aliases, `${path}.aliases`),
    description: readDescription(value.description, `${path}.description`),
  };
}

/**
 * Rejects normalized collisions within one namespace. A canonical name must be
 * distinct after normalization, and an alias must not collide with another
 * entry's name or alias.
 */
function checkCollisions(
  namespace: WhitelistNamespace,
  entries: readonly WhitelistEntry[],
  stateTagKeys: ReadonlySet<string>,
): void {
  const owners = new Map<string, string>();

  const register = (key: string, label: string): void => {
    const previous = owners.get(key);
    if (previous !== undefined) {
      fail(
        label,
        `normalized name collides with ${previous} within ${namespace}`,
      );
    }
    owners.set(key, label);
  };

  entries.forEach((entry, index) => {
    const prefix = `${namespace}[${index}]`;
    const nameKey = normalizeName(entry.name);
    if (stateTagKeys.has(nameKey)) {
      fail(
        `${prefix}.name`,
        `"${entry.name}" is a worker state tag and must not appear in the whitelist`,
      );
    }
    register(nameKey, `${prefix}.name "${entry.name}"`);

    entry.aliases.forEach((alias, aliasIndex) => {
      const aliasKey = normalizeName(alias);
      if (stateTagKeys.has(aliasKey)) {
        fail(
          `${prefix}.aliases[${aliasIndex}]`,
          `"${alias}" is a worker state tag and must not appear in the whitelist`,
        );
      }
      register(aliasKey, `${prefix}.aliases[${aliasIndex}] "${alias}"`);
    });
  });
}

function readNamespace(
  source: Record<string, unknown>,
  namespace: WhitelistNamespace,
  stateTagKeys: ReadonlySet<string>,
): WhitelistEntry[] {
  const value = source[namespace];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`whitelist.${namespace}`, "expected an array");
  }
  const entries = value.map((item, index) =>
    parseEntry(item, `${namespace}[${index}]`),
  );
  checkCollisions(namespace, entries, stateTagKeys);
  return entries;
}

export function stateTagKeys(stateTags: StateTagConfig): Set<string> {
  return new Set(Object.values(stateTags).map((name) => normalizeName(name)));
}

/**
 * Validates untrusted whitelist data. Throws an actionable error that names the
 * offending entry and never contains secrets.
 */
export function parseWhitelist(
  raw: unknown,
  stateTags: StateTagConfig,
): Whitelist {
  if (!isPlainObject(raw)) {
    fail("whitelist", "expected an object");
  }

  const version = raw.version;
  if (version !== WHITELIST_VERSION) {
    fail(
      "whitelist.version",
      `unsupported version ${JSON.stringify(version)}; expected ${WHITELIST_VERSION}`,
    );
  }

  const stateTagKeysSet = stateTagKeys(stateTags);
  return {
    version: WHITELIST_VERSION,
    tags: readNamespace(raw, "tags", stateTagKeysSet),
    correspondents: readNamespace(raw, "correspondents", stateTagKeysSet),
    documentTypes: readNamespace(raw, "documentTypes", stateTagKeysSet),
  };
}

export async function loadWhitelist(
  path: string,
  stateTags: StateTagConfig,
): Promise<Whitelist> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error) {
    throw new Error(
      `unable to read whitelist at ${path}: ${(error as Error).message}. ` +
        "Create it from whitelist.example.json in the data directory.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `whitelist at ${path} is not valid JSON: ${(error as Error).message}`,
    );
  }

  return parseWhitelist(raw, stateTags);
}

export type WhitelistResolution =
  | { status: "resolved"; entry: WhitelistEntry }
  | { status: "unknown"; query: string }
  | { status: "ambiguous"; query: string; entries: WhitelistEntry[] };

/**
 * Resolves a model-provided name to a whitelist entry by canonical name or
 * alias using trimmed, Unicode-normalized, case-insensitive matching.
 */
export function resolveWhitelistName(
  query: string,
  entries: readonly WhitelistEntry[],
): WhitelistResolution {
  const target = normalizeName(query);
  if (target.length === 0) {
    return { status: "unknown", query };
  }
  const matches = entries.filter(
    (entry) =>
      normalizeName(entry.name) === target ||
      entry.aliases.some((alias) => normalizeName(alias) === target),
  );
  if (matches.length === 0) {
    return { status: "unknown", query };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", query, entries: matches };
  }
  const entry = matches[0];
  if (entry === undefined) {
    return { status: "unknown", query };
  }
  return { status: "resolved", entry };
}

export function whitelistNamespace(
  whitelist: Whitelist,
  namespace: WhitelistNamespace,
): WhitelistEntry[] {
  return whitelist[namespace];
}

export function isWhitelistNamespace(
  value: string,
): value is WhitelistNamespace {
  return (NAMESPACES as readonly string[]).includes(value);
}
