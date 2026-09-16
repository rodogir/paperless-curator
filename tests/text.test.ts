import { describe, expect, test } from "bun:test";
import { prepareOcr, validateTitle } from "../src/text.ts";

describe("prepareOcr", () => {
  test("rejects empty content", () => {
    expect(prepareOcr("   \n\t ", 100).ok).toBe(false);
    expect(prepareOcr("", 100).ok).toBe(false);
  });

  test("passes through short content without truncation", () => {
    const result = prepareOcr("Hello world", 100);
    expect(result).toEqual({
      ok: true,
      text: "Hello world",
      truncated: false,
      originalLength: 11,
    });
  });

  test("keeps both the beginning and the end when truncating", () => {
    const head = "A".repeat(200);
    const tail = "Z".repeat(200);
    const middle = "M".repeat(1000);
    const content = `${head}${middle}${tail}`;
    const result = prepareOcr(content, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(1400);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text).toContain("truncated");
    expect(result.text.startsWith("A")).toBe(true);
    expect(result.text.endsWith("Z")).toBe(true);
  });

  test("is deterministic", () => {
    const content = "abcdefghij".repeat(10);
    expect(prepareOcr(content, 25)).toEqual(prepareOcr(content, 25));
  });
});

describe("validateTitle", () => {
  test("normalizes whitespace", () => {
    const result = validateTitle("  Hello   world \n", 100);
    expect(result).toEqual({ ok: true, title: "Hello world" });
  });

  test("rejects empty titles", () => {
    expect(validateTitle("   ", 100).ok).toBe(false);
  });

  test("rejects non-whitespace control characters", () => {
    expect(validateTitle("bad\u0000title", 100).ok).toBe(false);
    expect(validateTitle("bad\u0007title", 100).ok).toBe(false);
  });

  test("rejects overlong titles", () => {
    expect(validateTitle("x".repeat(129), 128).ok).toBe(false);
    expect(validateTitle("x".repeat(128), 128).ok).toBe(true);
  });
});
