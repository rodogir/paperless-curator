import type { WhitelistEntry } from "./whitelist.ts";

export const PROMPT_VERSION = "proposal-v2";

export type ChatMessage = { role: "system" | "user"; content: string };

export type PromptInput = {
  ocr: string;
  allowedTags: WhitelistEntry[];
  allowedCorrespondents: WhitelistEntry[];
  allowedDocumentTypes: WhitelistEntry[];
  current: {
    title: string;
    correspondent: string | null;
    documentType: string | null;
    tags: string[];
  };
};

export const SYSTEM_PROMPT = [
  "You classify scanned documents for a Paperless-ngx archive.",
  "You are given OCR text and the archive's human-curated vocabulary.",
  "Respond with a single JSON object and nothing else.",
  "Rules:",
  '- "title": a concise, human-readable title in the document\'s language. Never empty.',
  '- "tags": tag names to ADD, chosen only from the provided tag vocabulary.',
  '- "correspondent": one name from the provided correspondent vocabulary, or null.',
  '- "document_type": one name from the provided document type vocabulary, or null.',
  '- "review": true only when you genuinely cannot classify safely.',
  '- "review_reasons": short explanations when review is true, otherwise [].',
  '- "suggested_tags": values you believe are ideal but are missing from the vocabulary, each as {"name","reason"}.',
  '- "suggested_correspondent" and "suggested_document_type": one such suggestion object or null.',
  "Suggestions are recorded for human review and are never applied automatically.",
  "Never invent a value in tags, correspondent, or document_type; use the suggestion fields instead.",
  "Prefer an empty list or null over a guess when uncertain.",
].join("\n");

function formatOptions(options: readonly WhitelistEntry[]): string {
  if (options.length === 0) {
    return "(none available)";
  }
  return options
    .map((option) => {
      const parts = [option.name];
      if (option.description !== null) {
        parts.push(`— ${option.description}`);
      }
      if (option.aliases.length > 0) {
        parts.push(`(aliases: ${option.aliases.join(", ")})`);
      }
      return parts.join(" ");
    })
    .join("; ");
}

export function buildMessages(input: PromptInput): ChatMessage[] {
  const { current } = input;
  const sections = [
    "## Existing vocabulary (canonical names)",
    `Tags (choose additions only from this list): ${formatOptions(input.allowedTags)}`,
    `Correspondents: ${formatOptions(input.allowedCorrespondents)}`,
    `Document types: ${formatOptions(input.allowedDocumentTypes)}`,
    "",
    "## Current document",
    `Title: ${current.title || "(empty)"}`,
    `Correspondent: ${current.correspondent ?? "(empty)"}`,
    `Document type: ${current.documentType ?? "(empty)"}`,
    `Tags: ${current.tags.length > 0 ? current.tags.join(", ") : "(none)"}`,
    "",
    "## OCR text",
    input.ocr,
    "",
    "Return the JSON object now.",
  ];

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: sections.join("\n") },
  ];
}
