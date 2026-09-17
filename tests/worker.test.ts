import { describe, expect, test } from "bun:test";
import {
  type AppConfig,
  DEFAULT_OPERATIONS,
  DEFAULT_STATE_TAGS,
} from "../src/config.ts";
import type { Vocabularies } from "../src/decision.ts";
import { createLogger } from "../src/logger.ts";
import type { NamedEntity, StateTagIds } from "../src/metadata.ts";
import type { PaperlessContext } from "../src/paperless.ts";
import {
  type MemoryReviewArtifacts,
  memoryReviewArtifacts,
  REVIEW_STORE_VERSION,
  type ReviewRecord,
  type ReviewStore,
} from "../src/review.ts";
import type { Whitelist } from "../src/whitelist.ts";
import { runCycle } from "../src/worker.ts";
import { jsonResponse } from "./helpers.ts";

const stateTagIds: StateTagIds = {
  pending: 70,
  processing: 71,
  processed: 72,
  review: 73,
  failed: 74,
};

const stateTags: NamedEntity[] = [
  { id: 70, name: "ai-pending" },
  { id: 71, name: "ai-processing" },
  { id: 72, name: "ai-processed" },
  { id: 73, name: "ai-review" },
  { id: 74, name: "ai-failed" },
];

type FakeDoc = {
  id: number;
  title: string;
  tags: number[];
  correspondent: number | null;
  document_type: number | null;
  content: string;
  created: string;
  modified: string;
};

type FakeState = {
  tags: NamedEntity[];
  correspondents: NamedEntity[];
  documentTypes: NamedEntity[];
  documents: FakeDoc[];
};

type Recorded = { method: string; path: string; body: unknown };

function makeServer(initial: FakeState, llmResponses: unknown[]) {
  const state: FakeState = {
    tags: [...initial.tags],
    correspondents: [...initial.correspondents],
    documentTypes: [...initial.documentTypes],
    documents: initial.documents.map((doc) => ({
      ...doc,
      tags: [...doc.tags],
    })),
  };
  const requests: Recorded[] = [];
  let nextId = 1000;

  const page = (results: unknown[]): unknown => ({
    count: results.length,
    next: null,
    previous: null,
    results,
    display_count: results.length,
  });

  const detail = (doc: FakeDoc): unknown => ({
    id: doc.id,
    title: doc.title,
    tags: doc.tags,
    correspondent: doc.correspondent,
    document_type: doc.document_type,
    content: doc.content,
    created: doc.created,
    modified: doc.modified,
  });

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, path: url.pathname, body });

    if (url.hostname === "llm.invalid") {
      const fallback = llmResponses[llmResponses.length - 1];
      const response =
        llmResponses.length > 1 ? llmResponses.shift() : fallback;
      return jsonResponse(response);
    }

    if (method === "POST") {
      const name = (body as { name?: string }).name ?? `created-${nextId}`;
      const entity = { id: nextId, name };
      nextId += 1;
      if (url.pathname === "/api/tags/") state.tags.push(entity);
      else if (url.pathname === "/api/correspondents/")
        state.correspondents.push(entity);
      else if (url.pathname === "/api/document_types/")
        state.documentTypes.push(entity);
      else return new Response("not found", { status: 404 });
      return jsonResponse(entity, 201);
    }

    if (method === "PATCH") {
      const match = /^\/api\/documents\/(\d+)\/$/.exec(url.pathname);
      const doc = state.documents.find(
        (entry) => String(entry.id) === match?.[1],
      );
      if (doc === undefined) return new Response("not found", { status: 404 });
      const patch = body as Partial<FakeDoc>;
      if (patch.tags !== undefined) doc.tags = patch.tags;
      if (patch.title !== undefined) doc.title = patch.title;
      if (patch.correspondent !== undefined)
        doc.correspondent = patch.correspondent;
      if (patch.document_type !== undefined)
        doc.document_type = patch.document_type;
      return jsonResponse(detail(doc));
    }

    if (url.pathname === "/api/tags/") return jsonResponse(page(state.tags));
    if (url.pathname === "/api/correspondents/")
      return jsonResponse(page(state.correspondents));
    if (url.pathname === "/api/document_types/")
      return jsonResponse(page(state.documentTypes));
    if (url.pathname === "/api/documents/") {
      const all = url.searchParams.get("tags__id__all");
      const pendingId = all === null ? null : Number(all);
      const documents = state.documents.filter(
        (doc) => pendingId === null || doc.tags.includes(pendingId),
      );
      return jsonResponse(page(documents.map(detail)));
    }
    const match = /^\/api\/documents\/(\d+)\/$/.exec(url.pathname);
    if (match !== null) {
      const doc = state.documents.find(
        (entry) => String(entry.id) === match[1],
      );
      return doc === undefined
        ? new Response("not found", { status: 404 })
        : jsonResponse(detail(doc));
    }
    return new Response("not found", { status: 404 });
  };

  return { state, requests, fetchImpl };
}

function config(dryRun: boolean): AppConfig {
  return {
    version: 1,
    paperless: { baseUrl: "https://paperless.invalid" },
    llm: { baseUrl: "https://llm.invalid/v1", model: "test-model" },
    stateTags: DEFAULT_STATE_TAGS,
    dryRun,
    overwrite: { title: false, correspondent: false, documentType: false },
    limits: { maxTitleLength: 128, maxOcrChars: 30000 },
    request: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
    operations: DEFAULT_OPERATIONS,
    dataDir: "/tmp/opencode/unused",
  };
}

function whitelistOf(tags: string[], documentTypes: string[] = []): Whitelist {
  return {
    version: 1,
    tags: tags.map((name) => ({ name, aliases: [], description: null })),
    correspondents: [],
    documentTypes: documentTypes.map((name) => ({
      name,
      aliases: [],
      description: null,
    })),
  };
}

function llmResponse(proposal: unknown): unknown {
  return {
    choices: [{ message: { content: JSON.stringify(proposal) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function proposal(overrides: Record<string, unknown> = {}): unknown {
  return {
    title: "Generated Title",
    tags: [],
    correspondent: null,
    document_type: null,
    review: false,
    review_reasons: [],
    suggested_tags: [],
    suggested_correspondent: null,
    suggested_document_type: null,
    ...overrides,
  };
}

function deps(
  fake: ReturnType<typeof makeServer>,
  dryRun: boolean,
  whitelist: Whitelist,
  artifacts: MemoryReviewArtifacts,
  vocab: Vocabularies,
) {
  const paperless: PaperlessContext = {
    baseUrl: "https://paperless.invalid",
    token: "test-token",
    fetchImpl: fake.fetchImpl,
    retry: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
  };
  return {
    config: config(dryRun),
    paperless,
    llm: {
      baseUrl: "https://llm.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: fake.fetchImpl,
      retry: { timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 1 },
    },
    log: createLogger({ sink: () => {} }),
    whitelist,
    vocab,
    stateTagIds,
    artifacts,
  };
}

const baseDoc: FakeDoc = {
  id: 34,
  title: "",
  tags: [70],
  correspondent: null,
  document_type: null,
  content: "synthetic OCR text",
  created: "2026-09-03",
  modified: "2026-09-03T10:00:00Z",
};

function baseVocab(documentTypes: NamedEntity[] = []): Vocabularies {
  return {
    tags: [...stateTags, { id: 5, name: "Invoice" }],
    correspondents: [],
    documentTypes,
  };
}

function paperlessMutations(requests: Recorded[]): Recorded[] {
  return requests.filter(
    (entry) => entry.method !== "GET" && !entry.path.startsWith("/v1/"),
  );
}

describe("runCycle dry-run", () => {
  test("performs zero Paperless mutations", async () => {
    const fake = makeServer(
      {
        tags: stateTags,
        correspondents: [],
        documentTypes: [],
        documents: [baseDoc],
      },
      [llmResponse(proposal({ tags: ["Invoice"] }))],
    );
    const artifacts = memoryReviewArtifacts(() => "2026-01-02T10:00:00.000Z");
    const result = await runCycle(
      deps(
        fake,
        true,
        whitelistOf(["Invoice", "Passport"]),
        artifacts,
        baseVocab(),
      ),
    );

    expect(result.outcome).toBe("updated");
    expect(result.created).toEqual([
      { kind: "tag", name: "Passport", action: "would-create" },
    ]);
    expect(paperlessMutations(fake.requests)).toEqual([]);
    expect(fake.state.documents[0]?.tags).toEqual([70]);
  });

  test("reports a would-requeue without patching local state", async () => {
    const record: ReviewRecord = {
      documentId: 34,
      firstSeenAt: "2026-01-01T00:00:00.000Z",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
      status: "review",
      requeueable: true,
      attempts: 1,
      lastRequeueAt: null,
      current: { title: "", correspondent: null, documentType: null, tags: [] },
      proposal: null,
      reviewReasons: [],
      missing: [
        { kind: "documentType", name: "Passport", reason: "identity document" },
      ],
    };
    const store: ReviewStore = {
      version: REVIEW_STORE_VERSION,
      updatedAt: "",
      documents: { "34": record },
    };
    const fake = makeServer(
      {
        tags: stateTags,
        correspondents: [],
        documentTypes: [{ id: 18, name: "Passport" }],
        documents: [{ ...baseDoc, tags: [73] }],
      },
      [],
    );
    const artifacts = memoryReviewArtifacts(
      () => "2026-01-02T10:00:00.000Z",
      store,
    );
    const result = await runCycle(
      deps(
        fake,
        true,
        whitelistOf(["Invoice"], ["Passport"]),
        artifacts,
        baseVocab([{ id: 18, name: "Passport" }]),
      ),
    );
    expect(result.requeues).toEqual([
      { documentId: 34, action: "would-requeue" },
    ]);
    expect(paperlessMutations(fake.requests)).toEqual([]);
  });
});

describe("runCycle live", () => {
  test("claims, updates metadata, and applies the processed state", async () => {
    const fake = makeServer(
      {
        tags: stateTags,
        correspondents: [],
        documentTypes: [],
        documents: [{ ...baseDoc }],
      },
      [llmResponse(proposal({ title: "Generated Title", tags: ["Invoice"] }))],
    );
    const artifacts = memoryReviewArtifacts(() => "2026-01-02T10:00:00.000Z");
    const result = await runCycle(
      deps(fake, false, whitelistOf(["Invoice"]), artifacts, baseVocab()),
    );

    expect(result.outcome).toBe("updated");
    const patches = fake.requests.filter((entry) => entry.method === "PATCH");
    expect(patches.length).toBe(2);
    expect(patches[0]?.body).toEqual({ tags: [71] });
    expect(patches[1]?.body).toEqual({
      title: "Generated Title",
      tags: [5, 72],
    });
    expect(fake.state.documents[0]?.tags).toEqual([5, 72]);
    expect(fake.state.documents[0]?.title).toBe("Generated Title");
    // No non-whitelisted entity was created.
    expect(
      fake.requests.filter(
        (entry) => entry.method === "POST" && entry.path.startsWith("/api/"),
      ),
    ).toEqual([]);
  });

  test("leaves the document unclaimed and the model uncalled after a failed claim", async () => {
    const fake = makeServer(
      {
        tags: stateTags,
        correspondents: [],
        documentTypes: [],
        documents: [{ ...baseDoc }],
      },
      [llmResponse(proposal())],
    );
    // Fail the claim PATCH with a permanent error.
    const original = fake.fetchImpl;
    const failing = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if ((init?.method ?? "GET") === "PATCH") {
        return new Response(JSON.stringify({ detail: "rejected" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return original(input, init);
    }) as typeof fake.fetchImpl;

    const artifacts = memoryReviewArtifacts(() => "2026-01-02T10:00:00.000Z");
    const result = await runCycle(
      deps(
        { ...fake, fetchImpl: failing },
        false,
        whitelistOf(["Invoice"]),
        artifacts,
        baseVocab(),
      ),
    );
    expect(result.outcome).toBe("claim-failed");
    expect(
      fake.requests.some((entry) => entry.path === "/v1/chat/completions"),
    ).toBe(false);
  });
});

describe("runCycle review and requeue loop", () => {
  test("records a vocabulary gap, then requeues and processes after reconciliation", async () => {
    const fake = makeServer(
      {
        tags: stateTags,
        correspondents: [],
        documentTypes: [],
        documents: [{ ...baseDoc }],
      },
      [
        llmResponse(
          proposal({
            suggested_document_type: {
              name: "Passport",
              reason: "identity document",
            },
          }),
        ),
        llmResponse(proposal({ title: "Passport Doc", tags: ["Invoice"] })),
      ],
    );
    const artifacts = memoryReviewArtifacts(() => "2026-01-02T10:00:00.000Z");
    const vocab = baseVocab();

    // First cycle: model reports a whitelist gap -> review, requeueable.
    const first = await runCycle(
      deps(fake, false, whitelistOf(["Invoice"]), artifacts, vocab),
    );
    expect(first.outcome).toBe("review");
    expect(first.decision?.requeueable).toBe(true);
    const record = artifacts.getStore().documents["34"];
    expect(record?.missing).toEqual([
      { kind: "documentType", name: "Passport", reason: "identity document" },
    ]);
    expect(fake.state.documents[0]?.tags).toEqual([73]);
    expect(artifacts.getMarkdown()).toContain('documentType "Passport"');

    // A human adds Passport to the whitelist; the next cycle reconciles it,
    // requeues document 34, and processes it successfully.
    const second = await runCycle(
      deps(
        fake,
        false,
        whitelistOf(["Invoice"], ["Passport"]),
        artifacts,
        vocab,
      ),
    );

    const createdPassport = fake.requests.find(
      (entry) =>
        entry.method === "POST" && entry.path === "/api/document_types/",
    );
    expect(createdPassport?.body).toEqual({ name: "Passport" });
    expect(
      fake.requests.some(
        (entry) =>
          entry.method === "PATCH" &&
          JSON.stringify(entry.body) === JSON.stringify({ tags: [70] }),
      ),
    ).toBe(true);
    expect(second.requeues).toEqual([{ documentId: 34, action: "requeued" }]);
    expect(second.outcome).toBe("updated");
    expect(fake.state.documents[0]?.tags).toEqual([5, 72]);
    expect(fake.state.documents[0]?.title).toBe("Passport Doc");
    // The processed document is no longer in the review store.
    expect(artifacts.getStore().documents["34"]).toBeUndefined();
  });
});
