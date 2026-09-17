import { type AppConfig, loadConfig, resolveConfigPath } from "./config.ts";
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
import { type ProcessOutcome, processOneDocument } from "./process.ts";

function parseArgs(argv: readonly string[]): {
  configPath: string | null;
  documentId: number | null;
  help: boolean;
} {
  let configPath: string | null = null;
  let documentId: number | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
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
  return { configPath, documentId, help };
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

function summarizeOutcome(
  outcome: ProcessOutcome,
  vocab: {
    tagNames: Map<number, string>;
    correspondentNames: Map<number, string>;
    documentTypeNames: Map<number, string>;
  },
  config: AppConfig,
  model: string,
): Record<string, unknown> {
  if (outcome.kind === "no-candidate") {
    return { status: "no-eligible-document" };
  }
  if (outcome.kind === "model-invalid") {
    return {
      status: "review",
      documentId: outcome.documentId,
      reviewReasons: [`invalid model output: ${outcome.reason}`],
      promptVersion: outcome.promptVersion,
      durationMs: outcome.durationMs,
      dryRun: config.dryRun,
      model,
    };
  }

  const { decision } = outcome;
  const changes = decision.changes;
  return {
    status:
      decision.outcome === "update" ? "proposed-update" : decision.outcome,
    documentId: outcome.documentId,
    proposedTitle: changes.title,
    proposedTags: changes.addTagIds.map(
      (id) => vocab.tagNames.get(id) ?? String(id),
    ),
    proposedCorrespondent:
      changes.correspondentId === null
        ? null
        : (vocab.correspondentNames.get(changes.correspondentId) ??
          String(changes.correspondentId)),
    proposedDocumentType:
      changes.documentTypeId === null
        ? null
        : (vocab.documentTypeNames.get(changes.documentTypeId) ??
          String(changes.documentTypeId)),
    reviewReasons: decision.reviewReasons,
    notes: decision.notes,
    modelTitle: outcome.proposal?.title,
    modelUsage: outcome.usage,
    promptVersion: outcome.promptVersion,
    ocrChars: outcome.ocr?.chars,
    ocrOriginalChars: outcome.ocr?.originalChars,
    ocrTruncated: outcome.ocr?.truncated,
    durationMs: outcome.durationMs,
    dryRun: config.dryRun,
    model,
  };
}

const HELP = `paperless-curator (M1: read-only dry run)

Usage:
  bun run src/index.ts [--config <path>] [--document-id <id>]

Options:
  --config <path>       path to the JSON configuration file
  --document-id <id>    dry-run one deliberately selected document

Environment:
  PAPERLESS_API_TOKEN   required, Paperless API token
  LLM_API_KEY           required, OpenAI-compatible API key
  CONFIG_PATH           optional, path to config JSON (default: config.json)
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

  if (!config.dryRun) {
    log("error", "live-mode-disabled", {
      message:
        "live writes are not implemented in this milestone; set dryRun=true",
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

  log("info", "startup", {
    configPath,
    paperlessUrl: config.paperless.baseUrl,
    llmUrl: config.llm.baseUrl,
    model: config.llm.model,
    dryRun: config.dryRun,
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

  const outcome = await processOneDocument({
    config,
    paperless,
    llm,
    vocab: { tags, correspondents, documentTypes },
    stateTagIds,
    log,
    targetDocumentId: args.documentId ?? undefined,
  });

  log(
    "info",
    "proposal",
    summarizeOutcome(
      outcome,
      {
        tagNames: new Map(tags.map((tag) => [tag.id, tag.name])),
        correspondentNames: new Map(
          correspondents.map((entry) => [entry.id, entry.name]),
        ),
        documentTypeNames: new Map(
          documentTypes.map((entry) => [entry.id, entry.name]),
        ),
      },
      config,
      config.llm.model,
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
