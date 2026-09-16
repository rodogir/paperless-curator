export const PROMPT_VERSION = "proposal-v1";

export type ChatMessage = { role: "system" | "user"; content: string };

export type PromptInput = {
  ocr: string;
  allowedTags: string[];
  allowedCorrespondents: string[];
  allowedDocumentTypes: string[];
  current: {
    title: string;
    correspondent: string | null;
    documentType: string | null;
    tags: string[];
  };
};

export const SYSTEM_PROMPT = [
  "You classify scanned documents for a Paperless-ngx archive.",
  "You are given OCR text and the archive's existing vocabulary.",
  "Respond with a single JSON object and nothing else.",
  "Rules:",
  '- "title": a concise, human-readable title in the document\'s language. Never empty.',
  '- "tags": tag names to ADD, chosen only from the provided tag list.',
  '- "correspondent": one name from the provided correspondent list, or null.',
  '- "document_type": one name from the provided document type list, or null.',
  '- "review": true only when you genuinely cannot classify safely.',
  '- "review_reasons": short explanations when review is true, otherwise [].',
  "Never invent names that are not in the provided lists.",
  "Prefer an empty list or null over a guess when uncertain.",
].join("\n");

export function buildMessages(input: PromptInput): ChatMessage[] {
  const { current } = input;
  const sections = [
    "## Existing vocabulary",
    `Tags (choose additions only from this list): ${formatList(input.allowedTags)}`,
    `Correspondents: ${formatList(input.allowedCorrespondents)}`,
    `Document types: ${formatList(input.allowedDocumentTypes)}`,
    "",
    "## Current document",
    `Title: ${current.title || "(empty)"}`,
    `Correspondent: ${current.correspondent ?? "(empty)"}`,
    `Document type: ${current.documentType ?? "(empty)"}`,
    `Tags: ${formatList(current.tags)}`,
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

function formatList(values: readonly string[]): string {
  if (values.length === 0) {
    return "(none available)";
  }
  return values.join(", ");
}
