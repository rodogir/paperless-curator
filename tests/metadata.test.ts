import { describe, expect, test } from "bun:test";
import { DEFAULT_STATE_TAGS } from "../src/config.ts";
import {
  excludeStateTags,
  type NamedEntity,
  normalizeName,
  resolveName,
  resolveStateTags,
} from "../src/metadata.ts";

const tags: NamedEntity[] = [
  { id: 1, name: "Invoices" },
  { id: 2, name: "  invoices " },
  { id: 3, name: "Fahrzeug" },
  { id: 4, name: "Fahrzeuge" },
  { id: 5, name: "Ämtli" },
];

describe("normalizeName", () => {
  test("trims, collapses whitespace, and lowercases", () => {
    expect(normalizeName("  Hello   World ")).toBe("hello world");
  });

  test("applies NFKC so compatibility characters compare equal", () => {
    expect(normalizeName("ﬁle")).toBe(normalizeName("file"));
  });
});

describe("resolveName", () => {
  test("resolves a unique case-insensitive match", () => {
    expect(resolveName("fahrzeug", tags)).toEqual({
      status: "resolved",
      value: { id: 3, name: "Fahrzeug" },
    });
  });

  test("reports unknown names", () => {
    expect(resolveName("nope", tags).status).toBe("unknown");
  });

  test("treats multiple normalized matches as ambiguous", () => {
    const result = resolveName("invoices", tags);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates.map((candidate) => candidate.id).sort()).toEqual(
        [1, 2],
      );
    }
  });

  test("reports an empty query as unknown", () => {
    expect(resolveName("   ", tags).status).toBe("unknown");
  });
});

describe("resolveStateTags", () => {
  test("resolves all configured tags once", () => {
    const present: NamedEntity[] = [
      { id: 70, name: "ai-pending" },
      { id: 71, name: "ai-processing" },
      { id: 72, name: "ai-processed" },
      { id: 73, name: "ai-review" },
      { id: 74, name: "ai-failed" },
    ];
    const result = resolveStateTags(present, DEFAULT_STATE_TAGS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ids).toEqual({
        pending: 70,
        processing: 71,
        processed: 72,
        review: 73,
        failed: 74,
      });
      expect(result.all.sort()).toEqual([70, 71, 72, 73, 74]);
    }
  });

  test("reports missing tags", () => {
    const present: NamedEntity[] = [{ id: 70, name: "ai-pending" }];
    const result = resolveStateTags(present, DEFAULT_STATE_TAGS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.length).toBe(4);
      expect(result.problems[0]).toContain("ai-processing");
    }
  });

  test("reports ambiguous tags", () => {
    const present: NamedEntity[] = [
      { id: 70, name: "ai-pending" },
      { id: 99, name: "AI-PENDING" },
    ];
    const result = resolveStateTags(present, DEFAULT_STATE_TAGS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.problems.some((problem) => problem.includes("ambiguous")),
      ).toBe(true);
    }
  });
});

describe("excludeStateTags", () => {
  test("removes only the configured state tags", () => {
    const all = [...tags, { id: 70, name: "ai-pending" }];
    const filtered = excludeStateTags(all, [70]);
    expect(filtered.map((tag) => tag.id)).toEqual([1, 2, 3, 4, 5]);
  });
});
