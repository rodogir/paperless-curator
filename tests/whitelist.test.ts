import { describe, expect, test } from "bun:test";
import { DEFAULT_STATE_TAGS } from "../src/config.ts";
import {
  DEFAULT_WHITELIST_JSON,
  loadWhitelist,
  parseWhitelist,
  resolveWhitelistName,
  stateTagKeys,
  writeDefaultWhitelist,
} from "../src/whitelist.ts";

const valid = {
  version: 1,
  tags: [
    { name: "Invoice", aliases: ["Rechnung", "Faktura"], description: "Bills" },
    { name: "Contract" },
  ],
  correspondents: [{ name: "Existing Corp", aliases: ["NewCorp"] }],
  documentTypes: [{ name: "Passport", aliases: ["Reisepass"] }],
};

describe("parseWhitelist", () => {
  test("parses entries and applies optional-field defaults", () => {
    const whitelist = parseWhitelist(valid, DEFAULT_STATE_TAGS);
    expect(whitelist.version).toBe(1);
    expect(whitelist.tags[0]).toEqual({
      name: "Invoice",
      aliases: ["Rechnung", "Faktura"],
      description: "Bills",
    });
    expect(whitelist.tags[1]).toEqual({
      name: "Contract",
      aliases: [],
      description: null,
    });
  });

  test("treats missing namespaces as empty", () => {
    const whitelist = parseWhitelist({ version: 1 }, DEFAULT_STATE_TAGS);
    expect(whitelist.tags).toEqual([]);
    expect(whitelist.correspondents).toEqual([]);
    expect(whitelist.documentTypes).toEqual([]);
  });

  test("trims names and aliases", () => {
    const whitelist = parseWhitelist(
      { version: 1, tags: [{ name: "  Invoice  ", aliases: [" Rechnung "] }] },
      DEFAULT_STATE_TAGS,
    );
    expect(whitelist.tags[0]).toEqual({
      name: "Invoice",
      aliases: ["Rechnung"],
      description: null,
    });
  });

  test("rejects an unsupported version", () => {
    expect(() => parseWhitelist({ version: 2 }, DEFAULT_STATE_TAGS)).toThrow(
      /unsupported version/,
    );
    expect(() => parseWhitelist({}, DEFAULT_STATE_TAGS)).toThrow(
      /unsupported version/,
    );
  });

  test("rejects empty and non-string names", () => {
    expect(() =>
      parseWhitelist(
        { version: 1, tags: [{ name: "  " }] },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/tags\[0\]\.name/);
    expect(() =>
      parseWhitelist({ version: 1, tags: [{ name: 5 }] }, DEFAULT_STATE_TAGS),
    ).toThrow(/expected a string/);
  });

  test("rejects normalized duplicate names in one namespace", () => {
    expect(() =>
      parseWhitelist(
        { version: 1, tags: [{ name: "Invoice" }, { name: "  invoice " }] },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/collides/);
  });

  test("allows the same name in different namespaces", () => {
    const whitelist = parseWhitelist(
      {
        version: 1,
        tags: [{ name: "Passport" }],
        documentTypes: [{ name: "Passport" }],
      },
      DEFAULT_STATE_TAGS,
    );
    expect(whitelist.tags[0]?.name).toBe("Passport");
    expect(whitelist.documentTypes[0]?.name).toBe("Passport");
  });

  test("rejects an alias colliding with another entry's name", () => {
    expect(() =>
      parseWhitelist(
        {
          version: 1,
          tags: [
            { name: "Invoice", aliases: ["Contract"] },
            { name: "Contract" },
          ],
        },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/collides/);
  });

  test("rejects an alias colliding with another entry's alias", () => {
    expect(() =>
      parseWhitelist(
        {
          version: 1,
          tags: [
            { name: "Invoice", aliases: ["Rechnung"] },
            { name: "Bill", aliases: ["rechnung"] },
          ],
        },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/collides/);
  });

  test("rejects a state tag name in the whitelist", () => {
    expect(() =>
      parseWhitelist(
        { version: 1, tags: [{ name: "ai-pending" }] },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/worker state tag/);
  });

  test("rejects a state tag alias in any namespace", () => {
    expect(() =>
      parseWhitelist(
        { version: 1, correspondents: [{ name: "X", aliases: ["AI-REVIEW"] }] },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/worker state tag/);
  });

  test("rejects a whitespace-only description", () => {
    expect(() =>
      parseWhitelist(
        { version: 1, tags: [{ name: "Invoice", description: "  " }] },
        DEFAULT_STATE_TAGS,
      ),
    ).toThrow(/description/);
  });
});

describe("resolveWhitelistName", () => {
  const whitelist = parseWhitelist(valid, DEFAULT_STATE_TAGS);

  test("resolves a canonical name case-insensitively", () => {
    const result = resolveWhitelistName("invoice", whitelist.tags);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.entry.name).toBe("Invoice");
    }
  });

  test("resolves an alias to its canonical entry", () => {
    const result = resolveWhitelistName("Rechnung", whitelist.tags);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.entry.name).toBe("Invoice");
    }
  });

  test("reports unknown and empty queries", () => {
    expect(resolveWhitelistName("Nope", whitelist.tags).status).toBe("unknown");
    expect(resolveWhitelistName("   ", whitelist.tags).status).toBe("unknown");
  });
});

describe("stateTagKeys", () => {
  test("normalizes configured state tag names", () => {
    expect(stateTagKeys(DEFAULT_STATE_TAGS).has("ai-pending")).toBe(true);
  });
});

describe("loadWhitelist", () => {
  test("reads and validates a whitelist file", async () => {
    const path = `${import.meta.dir}/tmp-whitelist.json`;
    await Bun.write(path, JSON.stringify(valid));
    try {
      const whitelist = await loadWhitelist(path, DEFAULT_STATE_TAGS);
      expect(whitelist.tags.length).toBe(2);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("reports a missing file with an actionable message", async () => {
    await expect(
      loadWhitelist(
        `${import.meta.dir}/does-not-exist.json`,
        DEFAULT_STATE_TAGS,
      ),
    ).rejects.toThrow(/whitelist\.example\.json/);
  });
});

describe("default whitelist", () => {
  test("parses to an empty, valid whitelist", () => {
    const whitelist = parseWhitelist(
      JSON.parse(DEFAULT_WHITELIST_JSON),
      DEFAULT_STATE_TAGS,
    );
    expect(whitelist.tags).toEqual([]);
    expect(whitelist.correspondents).toEqual([]);
    expect(whitelist.documentTypes).toEqual([]);
  });

  test("writeDefaultWhitelist creates only when missing", async () => {
    const path = `${import.meta.dir}/tmp-default-whitelist.json`;
    if (await Bun.file(path).exists()) {
      await Bun.file(path).delete();
    }
    try {
      expect(await writeDefaultWhitelist(path)).toBe(true);
      const created = await loadWhitelist(path, DEFAULT_STATE_TAGS);
      expect(created.tags).toEqual([]);

      await Bun.write(path, JSON.stringify(valid));
      expect(await writeDefaultWhitelist(path)).toBe(false);
      const kept = await loadWhitelist(path, DEFAULT_STATE_TAGS);
      expect(kept.tags.length).toBe(2);
    } finally {
      await Bun.file(path).delete();
    }
  });
});
