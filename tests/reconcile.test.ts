import { describe, expect, test } from "bun:test";
import type { Vocabularies } from "../src/decision.ts";
import { createLogger } from "../src/logger.ts";
import type { PaperlessContext } from "../src/paperless.ts";
import { planReconciliation, reconcileWhitelist } from "../src/reconcile.ts";
import type { Whitelist } from "../src/whitelist.ts";
import { emptyVocab } from "./helpers.ts";

function whitelist(tags: string[], correspondents: string[] = []): Whitelist {
  return {
    version: 1,
    tags: tags.map((name) => ({ name, aliases: [], description: null })),
    correspondents: correspondents.map((name) => ({
      name,
      aliases: [],
      description: null,
    })),
    documentTypes: [],
  };
}

type Recorded = { method: string; path: string; body: string };

function context(recorded: Recorded[]): PaperlessContext {
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? "" : String(init.body);
    recorded.push({ method, path: url.pathname, body });
    const parsed =
      body.length > 0 ? (JSON.parse(body) as { name?: string }) : {};
    if (parsed.name === "Fail") {
      return new Response(JSON.stringify({ detail: "rejected" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ id: 900 + recorded.length, name: parsed.name }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return {
    baseUrl: "https://paperless.invalid",
    token: "test-token",
    fetchImpl,
    retry: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
  };
}

const silentLog = createLogger({ sink: () => {} });

describe("planReconciliation", () => {
  test("plans only whitelist entries missing from Paperless", () => {
    const vocab: Vocabularies = {
      ...emptyVocab(),
      tags: [{ id: 5, name: "Invoice" }],
    };
    const plan = planReconciliation(whitelist(["Invoice", "Passport"]), vocab);
    expect(plan.creations).toEqual([{ kind: "tag", name: "Passport" }]);
    expect(plan.problems).toEqual([]);
  });

  test("reports ambiguous normalized names instead of creating", () => {
    const vocab: Vocabularies = {
      ...emptyVocab(),
      tags: [
        { id: 1, name: "Passport" },
        { id: 2, name: "passport " },
      ],
    };
    const plan = planReconciliation(whitelist(["Passport"]), vocab);
    expect(plan.creations).toEqual([]);
    expect(plan.problems.length).toBe(1);
  });
});

describe("reconcileWhitelist dry-run", () => {
  test("reports would-create and makes zero requests", async () => {
    const recorded: Recorded[] = [];
    const result = await reconcileWhitelist(
      context(recorded),
      whitelist(["Passport"], ["Consulate"]),
      emptyVocab(),
      { dryRun: true, log: silentLog },
    );
    expect(recorded).toEqual([]);
    expect(result.outcomes).toEqual([
      { kind: "tag", name: "Passport", action: "would-create" },
      { kind: "correspondent", name: "Consulate", action: "would-create" },
    ]);
    expect(result.vocab.tags).toEqual([]);
  });
});

describe("reconcileWhitelist live", () => {
  test("creates only whitelisted missing entities", async () => {
    const recorded: Recorded[] = [];
    const result = await reconcileWhitelist(
      context(recorded),
      whitelist(["Invoice", "Passport"], ["Consulate"]),
      { ...emptyVocab(), tags: [{ id: 5, name: "Invoice" }] },
      { dryRun: false, log: silentLog },
    );

    expect(recorded.length).toBe(2);
    expect(recorded.every((entry) => entry.method === "POST")).toBe(true);
    expect(recorded.map((entry) => entry.path).sort()).toEqual([
      "/api/correspondents/",
      "/api/tags/",
    ]);
    expect(JSON.parse(recorded[0]?.body ?? "{}")).toEqual({ name: "Passport" });
    expect(result.outcomes.map((entry) => entry.action)).toEqual([
      "created",
      "created",
    ]);
    expect(result.vocab.tags.map((tag) => tag.name)).toEqual([
      "Invoice",
      "Passport",
    ]);
    expect(result.vocab.correspondents.map((entry) => entry.name)).toEqual([
      "Consulate",
    ]);
  });

  test("is idempotent across repeated runs", async () => {
    const recorded: Recorded[] = [];
    const ctx = context(recorded);
    const first = await reconcileWhitelist(
      ctx,
      whitelist(["Passport"]),
      emptyVocab(),
      { dryRun: false, log: silentLog },
    );
    const postsAfterFirst = recorded.length;
    const second = await reconcileWhitelist(
      ctx,
      whitelist(["Passport"]),
      first.vocab,
      { dryRun: false, log: silentLog },
    );
    expect(recorded.length).toBe(postsAfterFirst);
    expect(second.outcomes).toEqual([]);
  });

  test("a failed creation does not block the others", async () => {
    const recorded: Recorded[] = [];
    const result = await reconcileWhitelist(
      context(recorded),
      whitelist(["Fail", "Good"]),
      emptyVocab(),
      { dryRun: false, log: silentLog },
    );
    expect(result.outcomes).toEqual([
      {
        kind: "tag",
        name: "Fail",
        action: "failed",
        reason: expect.any(String),
      },
      { kind: "tag", name: "Good", action: "created", id: expect.any(Number) },
    ]);
  });
});
