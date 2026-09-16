export type OcrPreparation =
  | { ok: true; text: string; truncated: boolean; originalLength: number }
  | { ok: false; reason: string };

const TRUNCATION_MARKER = "\n[... content truncated ...]\n";

/**
 * Deterministically bounds OCR input while preserving content from both the
 * beginning and the end of the document.
 */
export function prepareOcr(content: string, maxChars: number): OcrPreparation {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return { ok: false, reason: "document has no OCR text" };
  }
  if (normalized.length <= maxChars) {
    return {
      ok: true,
      text: normalized,
      truncated: false,
      originalLength: normalized.length,
    };
  }

  const budget = maxChars - TRUNCATION_MARKER.length;
  if (budget <= 0) {
    return {
      ok: true,
      text: normalized.slice(0, maxChars),
      truncated: true,
      originalLength: normalized.length,
    };
  }

  const headLength = Math.ceil(budget / 2);
  const tailLength = budget - headLength;
  const head = normalized.slice(0, headLength);
  const tail = normalized.slice(normalized.length - tailLength);

  return {
    ok: true,
    text: `${head}${TRUNCATION_MARKER}${tail}`,
    truncated: true,
    originalLength: normalized.length,
  };
}

export type TitleValidation =
  { ok: true; title: string } | { ok: false; reason: string };

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Normalizes whitespace and validates a proposed document title.
 * Rejects empty titles, control characters, and overlong titles.
 */
export function validateTitle(raw: string, maxLength: number): TitleValidation {
  if (typeof raw !== "string") {
    return { ok: false, reason: "title is not a string" };
  }
  const title = raw.replace(/\s+/g, " ").trim();
  if (hasControlCharacters(title)) {
    return { ok: false, reason: "title contains control characters" };
  }
  if (title.length === 0) {
    return { ok: false, reason: "title is empty" };
  }
  if (title.length > maxLength) {
    return {
      ok: false,
      reason: `title is ${title.length} characters, over the limit of ${maxLength}`,
    };
  }
  return { ok: true, title };
}

export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}

export function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
