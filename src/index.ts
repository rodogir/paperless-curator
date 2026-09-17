import {
  type AppConfig,
  loadConfig,
  resolveConfigPath,
  resolveDataDir,
  reviewLogPath,
  reviewMarkdownPath,
  reviewStorePath,
  whitelistPath,
} from "./config.ts";
import { type RetryInfo, type RetryPolicy, sleep } from "./http.ts";
import type { LlmContext } from "./llm.ts";
import { createLogger, type Logger } from "./logger.ts";
import type { StateTagIds } from "./metadata.ts";
import {
  allStateTagIds,
  excludeStateTags,
  resolveStateTags,
} from "./metadata.ts";
import {
  listCorrespondents,
  listDocumentTypes,
  listTags,
  type PaperlessContext,
  type Tag,
} from "./paperless.ts";
import { fileReviewArtifacts } from "./review.ts";
import { loadWhitelist, type Whitelist } from "./whitelist.ts";
import { type CycleResult, runCycle } from "./worker.ts";

type ParsedArgs = {
  configPath: string | null;
  documentId: number | null;
  live: boolean;
  help: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  let configPath: string | null = null;
  let documentId: number | null = null;
  let live = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--config") {
      configPath = argv[index + 1] ?? null;
      index += 1;
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--document-id") {
      documentId = parseDocumentId(argv[index + 1]);
      index += 1;
    } else if (arg?.startsWith("--document-id=")) {
      documentId = parseDocumentId(arg.slice("--document-id=".length));
    }
  }
  return { configPath, documentId, live, help };
}

function parseDocumentId(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--document-id must be a positive integer, got ${value}`);
  }
  return parsed;
}

function retryPolicy(config: AppConfig): RetryPolicy {
  return {
    timeoutMs: config.request.timeoutMs,
    maxRetries: config.request.maxRetries,
    retryBackoffMs: config.request.retryBackoffMs,
  };
}

/**
 * Keeps retrying until the state tags can be validated. Missing or ambiguous
 * tags block processing; the process stays alive and periodically revalidates
 * while rate-limiting the actionable error log.
 */
async function resolveStateTagsWithRetry(
  ctx: PaperlessContext,
  config: AppConfig,
  log: Logger,
): Promise<{ tags: Tag[]; ids: StateTagIds }> {
  let attempt = 0;
  let lastProblemLogAt = 0;

  for (;;) {
    try {
      const tags = await listTags(ctx);
      const resolution = resolveStateTags(tags, config.stateTags);
      if (resolution.ok) {
        return { tags, ids: resolution.ids };
      }
      const now = Date.now();
      if (now - lastProblemLogAt > 60_000) {
        lastProblemLogAt = now;
        log("error", "state-tags-invalid", {
          problems: resolution.problems,
          action:
            "create the missing tags or fix their names in configuration; processing is blocked",
        });
      }
    } catch (error) {
      const now = Date.now();
      if (now - lastProblemLogAt > 30_000) {
        lastProblemLogAt = now;
        log("warn", "paperless-unavailable", {
          message: error instanceof Error ? error.message : String(error),
          attempt,
        });
      }
    }

    attempt += 1;
    await sleep(Math.min(2 ** Math.min(attempt, 6) * 1_000, 60_000));
  }
}

function summarizeCycle(
  result: CycleResult,
  tagNames: Map<number, string>,
  config: AppConfig,
): Record<string, unknown> {
  const decision = result.decision;
  const classification = result.classification;
  const modelTitle =
    classification?.kind === "classified"
      ? (classification.proposal?.title ?? null)
      : null;
  return {
    status: result.outcome,
    documentId: result.documentId,
    created: result.created.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      action: entry.action,
    })),
    requeues: result.requeues,
    proposedTitle: decision?.changes.title ?? null,
    proposedTags: (decision?.changes.addTagIds ?? []).map(
      (id) => tagNames.get(id) ?? String(id),
    ),
    proposedCorrespondentId: decision?.changes.correspondentId ?? null,
    proposedDocumentTypeId: decision?.changes.documentTypeId ?? null,
    reviewReasons: decision?.reviewReasons ?? [],
    requeueable: decision?.requeueable ?? false,
    missing: decision?.missing ?? [],
    notes: decision?.notes ?? [],
    modelTitle,
    promptVersion: classification?.promptVersion,
    model: config.llm.model,
    dryRun: config.dryRun,
  };
}

const HELP = `paperless-curator (M2: safe write path and review loop)

Usage:
  bun run src/index.ts [--config <path>] [--document-id <id>] [--live]

Options:
  --config <path>       path to the JSON configuration file
  --document-id <id>    process one deliberately selected document
  --live                enable Paperless writes (requires dryRun=false and
                        explicit approval); dry-run is the default

Environment:
  PAPERLESS_API_TOKEN   required, Paperless API token
  LLM_API_KEY           required, OpenAI-compatible API key
  CONFIG_PATH           optional, path to config JSON (default: config.json)
  DATA_DIR              optional, overrides config.dataDir (default: ./data)
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const log = createLogger();
  const configPath = args.configPath ?? resolveConfigPath(process.env);

  const token = process.env.PAPERLESS_API_TOKEN ?? "";
  const apiKey = process.env.LLM_API_KEY ?? "";
  if (token.trim().length === 0) {
    log("error", "config-error", { message: "PAPERLESS_API_TOKEN is not set" });
    return 1;
  }
  if (apiKey.trim().length === 0) {
    log("error", "config-error", { message: "LLM_API_KEY is not set" });
    return 1;
  }

  let config: AppConfig;
  try {
    config = await loadConfig(configPath);
  } catch (error) {
    log("error", "config-error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }

  // Explicit live-mode guard: writes require both dryRun=false in config and
  // the --live flag, so a configuration edit alone cannot enable writes.
  if (!config.dryRun && !args.live) {
    log("error", "live-mode-not-enabled", {
      message:
        "config has dryRun=false but --live was not passed; refusing to write",
    });
    return 1;
  }
  if (config.dryRun && args.live) {
    log("error", "live-mode-mismatch", {
      message: "--live was passed but config has dryRun=true; set dryRun=false",
    });
    return 1;
  }

  const retry = retryPolicy(config);
  const onRetry = (info: RetryInfo): void => {
    log("warn", "request-retry", { ...info });
  };
  const paperless: PaperlessContext = {
    baseUrl: config.paperless.baseUrl,
    token,
    fetchImpl: fetch,
    retry,
    onRetry,
  };
  const llm: LlmContext = {
    baseUrl: config.llm.baseUrl,
    apiKey,
    model: config.llm.model,
    fetchImpl: fetch,
    retry,
    onRetry,
  };

  const dataDir = resolveDataDir(process.env, config);

  log("info", "startup", {
    configPath,
    paperlessUrl: config.paperless.baseUrl,
    llmUrl: config.llm.baseUrl,
    model: config.llm.model,
    dryRun: config.dryRun,
    dataDir,
  });

  let whitelist: Whitelist;
  try {
    whitelist = await loadWhitelist(whitelistPath(dataDir), config.stateTags);
  } catch (error) {
    log("error", "whitelist-error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
  log("info", "whitelist-loaded", {
    tagCount: whitelist.tags.length,
    correspondentCount: whitelist.correspondents.length,
    documentTypeCount: whitelist.documentTypes.length,
  });

  const { tags, ids: stateTagIds } = await resolveStateTagsWithRetry(
    paperless,
    config,
    log,
  );
  log("info", "state-tags-validated", { stateTagIds });

  const [correspondents, documentTypes] = await Promise.all([
    listCorrespondents(paperless),
    listDocumentTypes(paperless),
  ]);
  const selectableTags = excludeStateTags(tags, allStateTagIds(stateTagIds));
  log("info", "vocabularies-loaded", {
    tagCount: selectableTags.length,
    correspondentCount: correspondents.length,
    documentTypeCount: documentTypes.length,
  });

  const artifacts = fileReviewArtifacts(
    {
      store: reviewStorePath(dataDir),
      markdown: reviewMarkdownPath(dataDir),
      log: reviewLogPath(dataDir),
    },
    () => new Date().toISOString(),
  );

  const result = await runCycle({
    config,
    paperless,
    llm,
    log,
    whitelist,
    vocab: { tags, correspondents, documentTypes },
    stateTagIds,
    artifacts,
    targetDocumentId: args.documentId ?? undefined,
  });

  log(
    "info",
    "cycle-complete",
    summarizeCycle(
      result,
      new Map(tags.map((tag) => [tag.id, tag.name])),
      config,
    ),
  );

  return 0;
}

try {
  const code = await main();
  process.exitCode = code;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `${JSON.stringify({ level: "error", event: "fatal", message })}\n`,
  );
  process.exitCode = 1;
}
