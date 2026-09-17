import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMITS,
  DEFAULT_REQUEST,
  DEFAULT_STATE_TAGS,
  PAPERLESS_TITLE_MAX_LENGTH,
  parseConfig,
} from "../src/config.ts";

const minimal = {
  version: 1,
  paperless: { baseUrl: "https://paperless.example.com" },
  llm: { baseUrl: "https://api.example.com/v1", model: "test-model" },
};

describe("parseConfig", () => {
  test("applies documented defaults", () => {
    const config = parseConfig(minimal);
    expect(config.dryRun).toBe(true);
    expect(config.overwrite).toEqual({
      title: false,
      correspondent: false,
      documentType: false,
    });
    expect(config.stateTags).toEqual(DEFAULT_STATE_TAGS);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.request).toEqual(DEFAULT_REQUEST);
    expect(config.limits.maxTitleLength).toBe(PAPERLESS_TITLE_MAX_LENGTH);
  });

  test("strips trailing slashes from base urls", () => {
    const config = parseConfig({
      ...minimal,
      paperless: { baseUrl: "https://paperless.example.com/" },
      llm: { baseUrl: "https://api.example.com/v1/", model: "m" },
    });
    expect(config.paperless.baseUrl).toBe("https://paperless.example.com");
    expect(config.llm.baseUrl).toBe("https://api.example.com/v1");
  });

  test("accepts explicit overrides", () => {
    const config = parseConfig({
      ...minimal,
      dryRun: false,
      overwrite: { title: true, correspondent: true, documentType: true },
      limits: { maxTitleLength: 80, maxOcrChars: 1000 },
      request: { timeoutMs: 5000, maxRetries: 0, retryBackoffMs: 100 },
      stateTags: {
        pending: "p",
        processing: "q",
        processed: "r",
        review: "s",
        failed: "t",
      },
    });
    expect(config.dryRun).toBe(false);
    expect(config.overwrite.title).toBe(true);
    expect(config.limits.maxOcrChars).toBe(1000);
    expect(config.request.maxRetries).toBe(0);
    expect(config.stateTags.pending).toBe("p");
  });

  test("rejects an unsupported version", () => {
    expect(() => parseConfig({ ...minimal, version: 2 })).toThrow(
      /unsupported version/,
    );
    expect(() => parseConfig({ ...minimal, version: undefined })).toThrow(
      /unsupported version/,
    );
  });

  test("rejects a missing paperless url", () => {
    expect(() => parseConfig({ ...minimal, paperless: {} })).toThrow(
      /config\.paperless\.baseUrl/,
    );
  });

  test("rejects a non-http url", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        paperless: { baseUrl: "ftp://paperless.example.com" },
      }),
    ).toThrow(/http or https/);
  });

  test("rejects a title limit above the Paperless maximum", () => {
    expect(() =>
      parseConfig({ ...minimal, limits: { maxTitleLength: 200 } }),
    ).toThrow(/between 1 and 128/);
  });

  test("rejects duplicate state tag names", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        stateTags: {
          pending: "ai-x",
          processing: "AI-X",
          processed: "r",
          review: "s",
          failed: "t",
        },
      }),
    ).toThrow(/must be distinct/);
  });

  test("rejects an empty model", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        llm: { baseUrl: "https://api.example.com", model: "  " },
      }),
    ).toThrow(/config\.llm\.model/);
  });
});
