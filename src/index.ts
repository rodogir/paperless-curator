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
import type { Vocabularies } from "./decision.ts";
import type { RetryInfo, RetryPolicy } from "./http.ts";
import type { LlmContext } from "./llm.ts";
import { createLogger } from "./logger.ts";
import { resolveStateTags } from "./metadata.ts";
import {
  listCorrespondents,
  listDocumentTypes,
  listTags,
  type PaperlessContext,
} from "./paperless.ts";
import { fileReviewArtifacts } from "./review.ts";
import { runWorkerLoop, type WorkerState } from "./runner.ts";
import { loadWhitelist } from "./whitelist.ts";
import { type CycleResult, runCycle } from "./worker.ts";

type ParsedArgs = {
  configPath: string | null;
  documentId: number | null;
  live: boolean;
  once: boolean;
  help: boolean;
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  let configPath: string | null = null;
  let documentId: number | null = null;
  let live = false;
  let once = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--once") {
      once = true;
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
  return { configPath, documentId, live, once, help };
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

function summarizeCycle(
  result: CycleResult,
  tagNames: Map<number, string>,
  config: AppConfig,
  durationMs: number,
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
    durationMs,
    created: result.created.map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      action: entry.action,
    })),
    requeues: result.requeues,
    staleRecoveries: result.staleRecoveries,
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

const HELP = `paperless-curator (M3: operational minimum)

Usage:
  bun run src/index.ts [--config <path>] [--document-id <id>] [--live] [--once]

Options:
  --config <path>       path to the JSON configuration file
  --document-id <id>    process one deliberately selected document
  --live                enable Paperless writes (requires dryRun=false and
                        explicit approval); dry-run is the default
  --once                run a single cycle and exit instead of polling

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
    mode: args.once ? "once" : "continuous",
    pollIntervalMs: config.operations.pollIntervalMs,
    vocabularyRefreshMs: config.operations.vocabularyRefreshMs,
    staleProcessingThresholdMs: config.operations.staleProcessingThresholdMs,
    dataDir,
  });

  // Invalid whitelist configuration is a fatal startup error. Reloads after
  // startup block processing instead (handled inside the loop).
  try {
    const whitelist = await loadWhitelist(
      whitelistPath(dataDir),
      config.stateTags,
    );
    log("info", "whitelist-loaded", {
      tagCount: whitelist.tags.length,
      correspondentCount: whitelist.correspondents.length,
      documentTypeCount: whitelist.documentTypes.length,
    });
  } catch (error) {
    log("error", "whitelist-error", {
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }

  const artifacts = fileReviewArtifacts(
    {
      store: reviewStorePath(dataDir),
      markdown: reviewMarkdownPath(dataDir),
      log: reviewLogPath(dataDir),
    },
    () => new Date().toISOString(),
  );

  // Re-reads the whitelist and re-lists every Paperless vocabulary. Throwing
  // here blocks processing and is retried with capped backoff by the loop.
  const refresh = async (): Promise<WorkerState> => {
    const whitelist = await loadWhitelist(
      whitelistPath(dataDir),
      config.stateTags,
    );
    const tags = await listTags(paperless);
    const resolution = resolveStateTags(tags, config.stateTags);
    if (!resolution.ok) {
      throw new Error(`state tags invalid: ${resolution.problems.join("; ")}`);
    }
    log("info", "state-tags-validated", { stateTagIds: resolution.ids });
    const [correspondents, documentTypes] = await Promise.all([
      listCorrespondents(paperless),
      listDocumentTypes(paperless),
    ]);
    const vocab: Vocabularies = { tags, correspondents, documentTypes };
    return { whitelist, vocab, stateTagIds: resolution.ids };
  };

  const cycle = async (state: WorkerState): Promise<CycleResult> => {
    const startedAt = Date.now();
    const result = await runCycle({
      config,
      paperless,
      llm,
      log,
      whitelist: state.whitelist,
      vocab: state.vocab,
      stateTagIds: state.stateTagIds,
      artifacts,
      targetDocumentId: args.documentId ?? undefined,
    });
    log(
      "info",
      "cycle-complete",
      summarizeCycle(
        result,
        new Map(state.vocab.tags.map((tag) => [tag.id, tag.name])),
        config,
        Date.now() - startedAt,
      ),
    );
    return result;
  };

  const controller = new AbortController();
  const requestShutdown = (signal: NodeJS.Signals): void => {
    log("info", "shutdown-requested", { signal });
    controller.abort();
  };
  const onSigint = (): void => requestShutdown("SIGINT");
  const onSigterm = (): void => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const loop = await runWorkerLoop({
      config,
      log,
      initial: null,
      refresh,
      cycle,
      maxCycles: args.once ? 1 : undefined,
      signal: controller.signal,
    });
    log("info", "worker-exit", {
      reason: loop.reason,
      cycles: loop.cycles,
      lastOutcome: loop.lastOutcome,
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }

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
