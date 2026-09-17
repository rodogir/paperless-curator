export type LogLevel = "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type Logger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
) => void;

export type LoggerOptions = {
  sink?: (line: string) => void;
  now?: () => string;
};

/**
 * Structured single-line JSON logger.
 *
 * Callers are responsible for never passing secrets, OCR text, full prompts,
 * or raw upstream payloads. This logger only serializes the fields it is given.
 */
/**
 * Wraps a logger so that repeated events are emitted at most once per window,
 * keyed by event name. Distinct events pass through unchanged. Used to keep
 * service-connectivity and refresh failures from flooding stdout while the
 * worker retries indefinitely.
 */
export function withRateLimit(
  log: Logger,
  windowMs: number,
  now: () => number = Date.now,
): Logger {
  const lastLoggedAt = new Map<string, number>();
  return (level, event, fields) => {
    const current = now();
    const previous = lastLoggedAt.get(event);
    if (previous !== undefined && current - previous < windowMs) {
      return;
    }
    lastLoggedAt.set(event, current);
    log(level, event, fields);
  };
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink =
    options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());

  return (level, event, fields = {}) => {
    const record: Record<string, unknown> = {
      ts: now(),
      level,
      event,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        record[key] = value;
      }
    }
    sink(JSON.stringify(record));
  };
}
