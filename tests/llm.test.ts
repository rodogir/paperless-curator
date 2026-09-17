import { describe, expect, test } from "bun:test";
import { UpstreamError } from "../src/errors.ts";
import {
  callModel,
  type LlmContext,
  PROPOSAL_SCHEMA,
  parseProposal,
} from "../src/llm.ts";
import type { PromptInput } from "../src/prompt.ts";
import { jsonResponse, loadFixture } from "./helpers.ts";

const promptInput: PromptInput = {
  ocr: "synthetic OCR text",
  allowedTags: ["Example Tag"],
  allowedCorrespondents: ["Example Correspondent"],
  allowedDocumentTypes: ["Example Type"],
  current: {
    title: "Scanned Document",
    correspondent: null,
    documentType: null,
    tags: [],
  },
};

function context(
  fetchImpl: LlmContext["fetchImpl"],
  maxRetries = 0,
): LlmContext {
  return {
    baseUrl: "https://llm.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
    retry: { timeoutMs: 1000, maxRetries, retryBackoffMs: 1 },
  };
}

describe("parseProposal", () => {
  test("accepts a well-formed proposal", () => {
    const result = parseProposal({
      title: "Statement",
      tags: ["Example Tag"],
      correspondent: "Example Correspondent",
      document_type: null,
      review: false,
      review_reasons: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Statement");
      expect(result.value.documentType).toBeNull();
    }
  });

  test("rejects missing and mistyped fields", () => {
    expect(parseProposal({ title: "", tags: [42], review: "yes" }).ok).toBe(
      false,
    );
    expect(parseProposal("not an object").ok).toBe(false);
  });
});

describe("callModel", () => {
  test("parses a valid structured response", async () => {
    const fixture = await loadFixture("llm/proposal-valid.json");
    const result = await callModel(
      context(async () => jsonResponse(fixture)),
      promptInput,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.promptVersion).toBe("proposal-v1");
      expect(result.proposal.title).toBe("Example Statement January 2026");
      expect(result.usage.totalTokens).toBe(120);
    }
  });

  test("sends a strict json_schema response_format", async () => {
    let capturedBody = "";
    const fixture = await loadFixture("llm/proposal-valid.json");
    await callModel(
      context(async (_input, init) => {
        capturedBody = String(init?.body ?? "");
        return jsonResponse(fixture);
      }),
      promptInput,
    );
    const body = JSON.parse(capturedBody) as {
      model: string;
      response_format: {
        type: string;
        json_schema: { strict: boolean; schema: unknown };
      };
    };
    expect(body.model).toBe("test-model");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema).toEqual(PROPOSAL_SCHEMA);
  });

  test("returns ok:false for invalid model output", async () => {
    const fixture = await loadFixture("llm/proposal-invalid.json");
    const result = await callModel(
      context(async () => jsonResponse(fixture)),
      promptInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("validation");
      expect(result.promptVersion).toBe("proposal-v1");
    }
  });

  test("retries transient network failures and then gives up", async () => {
    let calls = 0;
    const failing = context(async () => {
      calls += 1;
      throw new TypeError("connection refused");
    }, 1);
    await expect(callModel(failing, promptInput)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(calls).toBe(2);
  });

  test("does not retry permanent failures", async () => {
    let calls = 0;
    const unauthorized = context(async () => {
      calls += 1;
      return jsonResponse({ error: { message: "unauthorized" } }, 401);
    }, 3);
    await expect(callModel(unauthorized, promptInput)).rejects.toMatchObject({
      category: "permanent",
      status: 401,
    });
    expect(calls).toBe(1);
  });
});
