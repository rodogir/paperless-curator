# Paperless Curator MVP Plan

## Purpose

Paperless Curator is a small Bun and TypeScript worker that uses OCR text from
Paperless-ngx and an [OI]-compatible LLM API to suggest and apply document
metadata.

The first goal is not a production-ready deployment. It is a working local
vertical slice that can be exercised against a real Paperless-ngx v3 beta
instance and a real LLM endpoint. Docker, Unraid, CI, and image publishing come
after the core workflow has proven useful.

## Delivery Priorities

Work in this order:

1. Confirm the external API contracts needed by the worker.
2. Run a read-only dry-run against real services.
3. Define the human-curated metadata whitelist and the file-based review loop
   that grows it.
4. Add the smallest safe Paperless write path, including creating whitelisted
   entities and automatically requeueing review documents whose gaps are filled.
5. Add only the operational safeguards needed to run the worker reliably.
6. Package and automate the proven application.

When scope or design choices compete, prefer the option that gets the vertical
slice tested sooner without weakening the safety rules in this document.

## MVP Capabilities

The worker will:

- Poll Paperless for one eligible document at a time.
- Read the document's OCR content and current metadata through the API.
- Ask one configured [OI]-compatible model for a title and metadata, allowing
  it to choose document metadata only from the human-curated whitelist.
- Create missing Paperless tags, correspondents, and document types only when
  they are explicitly named in the human-curated whitelist.
- Validate all model output in the application.
- Add tags without removing document tags.
- Set or, when explicitly enabled, overwrite the title, correspondent, and
  document type.
- Send documents with unsafe or unresolved results to review and record a
  structured review artifact: the proposal, the reasons, and any entities the
  model wanted but the whitelist lacks, each with a reason.
- Automatically requeue a reviewed document when its only blockers were missing
  entities and those entities now exist after whitelist reconciliation.
- Track processing with pre-existing Paperless tags.
- Support a dry-run mode that performs no Paperless mutations.
- Log useful processing information without logging OCR content or secrets.

The worker will never:

- Modify document contents.
- Delete documents or metadata.
- Create tags, correspondents, or document types from model output or from any
  source other than the human-curated whitelist.
- Allow the LLM to call Paperless directly.
- Access Paperless document files through the filesystem.
- Expose a network port or run a web UI.

## Explicit Non-Goals

The initial functional milestones do not include:

- Docker or Unraid packaging.
- GitHub Actions or GHCR publishing.
- A database or server-side durable state beyond small JSON/JSONL files in a
  mounted data directory.
- Multi-instance coordination.
- Webhooks, a web UI, or a public HTTP server. The review workflow is
  deliberately file-based: a human edits a mounted whitelist file and reads a
  generated review file instead of using a custom UI. A UI was discussed and
  intentionally deferred; the whitelist/review-file loop is the chosen design.
- PDFs, images, or multimodal model input.
- Custom fields, summaries, semantic search, or chat.
- Generic support for unrelated model or document-management APIs.
- A plugin system, agent framework, LangChain, or speculative abstractions.
- Formal repository governance or a repository-local review skill.

These items may be reconsidered after the local workflow has been tested.

## Engineering Principles

- Use Bun and TypeScript.
- Prefer Bun and Web platform APIs over dependencies.
- Add a dependency only when it removes meaningful complexity or risk.
- Use Bun's built-in test runner.
- Prefer functions and plain data over classes and OO hierarchies.
- Keep deterministic business rules in small pure functions where practical.
- Keep HTTP, polling, configuration, logging, and other side effects explicit.
- Use TypeScript inference where it remains clear; specify types at untrusted
  boundaries and where they improve understanding.
- Prefer direct, specific code over generic adapters and multiple abstraction
  layers.
- Do not design for hypothetical providers or future multimodal behavior.
- Keep modules few and cohesive; split code when responsibilities become hard
  to follow or pure logic benefits from isolated tests.
- Optimize for code that is easy to inspect, test, change, or delete after the
  first real-world trial.

These are initial ground rules, not a complete style guide. Refine them after
the first implementation produces concrete feedback.

## Configuration Contract

Normal settings live in one versioned TOML file. TOML is used so the
configuration can carry comments. The metadata whitelist lives in a separate
human-curated JSON file (see Metadata Whitelist). Secrets remain in environment
variables.

Required environment variables:

- `PAPERLESS_API_TOKEN`
- `LLM_API_KEY`

Optional environment variables:

- `CONFIG_PATH`, with a documented default path
- `DATA_DIR`, with a documented default path, overriding `config.dataDir`

Initial configuration categories:

- Paperless URL
- LLM base URL and model
- Poll interval; processing is fixed to one document and is not configurable
- Pending, processing, processed, review, and failed tag names
- Dry-run mode
- Title, correspondent, and document-type overwrite flags
- Request timeout, retry count, and retry backoff
- OCR and title limits
- Metadata refresh interval
- Stale-processing threshold
- Service-connectivity retry backoff (initial delay and cap)
- Data directory containing the whitelist and review files

The data directory (`config.dataDir`, default `./data`, overridden by
`DATA_DIR`) contains every durable or human-edited file:

- `whitelist.json` — human-curated, authoritative metadata vocabulary
- `review.json` — worker-managed review store (see Review Artifact And Requeue)
- `review.md` — worker-generated human-readable review view
- `review-log.jsonl` — append-only decision history

The whitelist has its own small versioned example (`whitelist.example.json`) and
the real `whitelist.json` is git-ignored.

Configuration is validated at startup. Invalid configuration is a fatal error
with an actionable message. Paperless or LLM network unavailability is not a
fatal configuration error: the worker remains running and retries.

Conservative initial defaults:

- Dry-run enabled
- All metadata overwrite options disabled
- Maximum generated title length: 128 characters. Paperless-ngx v3 declares
  `title` `max_length: 128`, so a longer generated title would be rejected. This
  replaces the earlier 200-character default.
- Maximum OCR input: 30,000 characters
- Poll interval: 60 seconds
- Metadata refresh interval: 15 minutes
- Data directory: `./data`
- Bounded request timeout: 30 seconds
- Two retries after the initial request, with exponential backoff starting at
  one second
- Indefinite service-connectivity retries with backoff capped at 60 seconds
- Stale-processing threshold: 15 minutes (live mode only). This is far larger
  than the bounded worst case of one claimed document and larger than the poll
  and refresh intervals, so a healthy worker never sees its own active document
  as stale. Recovery uses `document.modified`; see `docs/api-notes.md` for the
  confirmed semantics and its limitation.

When OCR exceeds the limit, use deterministic truncation that retains content
from both the beginning and end, and log that truncation occurred. Adjust this
only after observing real documents and model behavior.

## External Contracts

The implementation targets:

- Paperless-ngx v3 beta
- One [OI]-compatible chat-completions style endpoint

Before client code is finalized, confirm the installed Paperless API behavior
for authentication, pagination, filtering documents by tag, OCR content,
document updates, and metadata vocabulary endpoints. Record tested API shapes
in fixtures rather than building broad version compatibility. Confirmed M0
findings live in `docs/api-notes.md`.

M2 additionally requires confirming the entity-creation endpoints
(`POST /api/tags/`, `/api/correspondents/`, and `/api/document_types/`) and
their duplicate-name behavior against the installed instance, and recording the
results before relying on them.

The LLM response contract is versioned. The current version is `proposal-v2`
and is a small validated object:

```json
{
  "title": "Passaporte do Brasil",
  "tags": ["Invoice"],
  "correspondent": "Existing Corp",
  "document_type": null,
  "review": false,
  "review_reasons": [],
  "suggested_tags": [{ "name": "Passport", "reason": "identifies a passport" }],
  "suggested_correspondent": {
    "name": "Consulate",
    "reason": "document was issued by the consulate"
  },
  "suggested_document_type": {
    "name": "Passport",
    "reason": "identity document"
  }
}
```

Rules:

- `title`, `tags`, `correspondent`, and `document_type` may only reference
  values offered from the whitelist. Application-side matching resolves aliases
  to their canonical name.
- `suggested_tags`, `suggested_correspondent`, and `suggested_document_type`
  capture values the model believes are ideal but that are absent from the
  whitelist. They are never applied. They are recorded in the review artifact so
  a human can decide whether to add them, with a reason for each.
- Every suggested entity carries a short `reason` so a human can judge it.
- `review: true` with `review_reasons` is used when the model cannot classify
  safely even with suggestions.
- All fields are required. `correspondent`, `document_type`, and the individual
  suggestion objects may be `null`; the suggestion arrays may be empty.

Numeric confidence is not required initially. Application validation, not a
model-generated score, determines whether an update is safe. The exact
structured-output mechanism should follow what the selected endpoint reliably
supports while retaining local response validation.

## Processing Eligibility And State

The worker supports one running instance. Multi-instance claiming safety is
out of scope and must be documented before deployment.

The configured state tags are:

- `ai-pending`
- `ai-processing`
- `ai-processed`
- `ai-review`
- `ai-failed`

Actual names are configurable. All five tags must already exist in Paperless.
The worker never creates them. Once Paperless is reachable, a missing or
ambiguous state tag blocks processing and is logged as an actionable
configuration error. The process remains alive, periodically reloads the tags,
and resumes only after the configuration problem has been corrected. Repeated
errors should be rate-limited to avoid noisy logs.

State tags are mutually exclusive. A document is eligible only when it has the
pending tag and none of the other four state tags. Conflicting state tags are
not repaired automatically; the document is skipped and the problem is
logged.

Normal live transitions are:

```text
pending -> processing -> processed
                      -> review
                      -> failed
```

A reviewed document is automatically requeued (`review -> pending`) when its
only blockers were entities missing from the whitelist and all of those
entities now exist after whitelist reconciliation:

```text
review -> pending   (automatic, only for requeueable vocabulary gaps)
```

Reprocessing a terminal document is otherwise an explicit manual action: remove
the terminal state and leave the document with only the pending state tag.

Dry-run mode performs no Paperless mutations, including no state-tag changes.
It may therefore inspect a document that another worker could process. Running
dry-run and live workers concurrently is unsupported.

## Metadata Rules

Paperless is the source of truth for the entities that exist. The
human-curated whitelist is authoritative for what the model may assign.

- Fetch complete paginated Paperless vocabularies at startup after connectivity
  is established, then refresh them periodically. These are used to resolve
  whitelist names to Paperless ids and to detect missing entities.
- Exclude all worker-state tags from the whitelist and from anything offered to
  the model.
- Match whitelist entries and model suggestions using trimmed, Unicode-
  normalized, case-insensitive exact names.
- Resolve an offered name against the whitelist. Aliases resolve to their
  canonical entry.
- Treat multiple normalized matches as ambiguous; never choose arbitrarily.
- A model value that resolves to no whitelist entry is a vocabulary gap: it is
  recorded as a suggestion for review, never applied.
- Preserve all existing non-state document tags.
- Adding a tag already present is a no-op.
- Populate an empty title, correspondent, or document type.
- Preserve a non-empty value unless its specific overwrite option is enabled.
- Re-fetch the document before a live update and re-evaluate overwrite rules.
- Treat unchanged values as no-ops.

The model's general uncertainty does not automatically require review. Review
is required when the model explicitly cannot classify safely, when a selected
metadata value cannot be resolved uniquely, when an application validation rule
fails, or when the model reports a vocabulary gap that the application cannot
resolve.

Title validation initially:

- Trim and normalize whitespace.
- Reject empty titles and control characters.
- Reject titles over the configured maximum.
- Do not attempt subjective semantic scoring in the first version.

## Metadata Whitelist

The whitelist is a human-curated, authoritative JSON file in the mounted data
directory. The model may only assign canonical entries from it. The worker may
create Paperless entities only for whitelist entries; it never creates entities
from model output. There are three independent namespaces: tags, correspondents,
and document types.

`whitelist.json`:

```json
{
  "version": 1,
  "tags": [
    {
      "name": "Invoice",
      "aliases": ["Rechnung", "Faktura"],
      "description": "Bills and invoices"
    }
  ],
  "correspondents": [
    {
      "name": "Existing Corp",
      "aliases": ["NewCorp"],
      "description": "Use for all NewCorp mail"
    }
  ],
  "documentTypes": [
    {
      "name": "Passport",
      "aliases": ["Reisepass"],
      "description": "Identity documents"
    }
  ]
}
```

Rules:

- `name` is required and is the canonical, user-facing value.
- `aliases` and `description` are optional. Aliases resolve model output to the
  canonical entry. Descriptions are offered to the model to improve selection;
  this is the mechanism for steering "use this one instead".
- Names must be non-empty and distinct after normalization within each
  namespace. Aliases must not collide with another entry's name or alias in the
  same namespace.
- State tag names must not appear in the whitelist.
- The whitelist is validated with an actionable error and is never guessed at.
  Invalid whitelist configuration is a fatal startup error.

### Reconciliation And Entity Creation

Once Paperless is reachable, the worker reconciles the whitelist on each cycle:

- For every whitelist entry, look up the Paperless entity by normalized name.
- If it is missing and live mode is enabled, create it. Creation is idempotent:
  re-check by normalized name before creating to avoid duplicates.
- In dry-run mode, report what would be created and create nothing.
- Log each creation with its kind and name. Never create an entity that is not
  named in the whitelist.
- A failed creation is logged and does not block processing other documents.

## Review Artifact And Requeue

When a document is not fully resolvable, it transitions to `ai-review` and the
worker records a structured review artifact. This artifact is the operator's
interface: it explains what the model proposed and why review was required.

`review.json` is keyed by document id:

```json
{
  "version": 1,
  "updatedAt": "2026-01-02T10:00:00.000Z",
  "documents": {
    "34": {
      "documentId": 34,
      "firstSeenAt": "2026-01-02T09:00:00.000Z",
      "lastSeenAt": "2026-01-02T10:00:00.000Z",
      "status": "review",
      "requeueable": true,
      "attempts": 1,
      "current": {
        "title": "DocScanner Sep 3, 2026 15-38",
        "correspondent": null,
        "documentType": null,
        "tags": []
      },
      "proposal": {
        "title": "Passaporte do Brasil",
        "tags": [],
        "correspondent": null,
        "documentType": null
      },
      "reviewReasons": ["missing whitelist entries: documentTypes: Passport"],
      "missing": [
        {
          "kind": "documentType",
          "name": "Passport",
          "reason": "identity document"
        }
      ]
    }
  }
}
```

- `status` is one of `review` or `failed`.
- `requeueable` is `true` only when every blocker is a missing entity recorded
  in `missing`. It is `false` for model uncertainty, ambiguous matches, invalid
  output, or unusable OCR.
- `missing` uses `kind` values `tag`, `correspondent`, or `documentType`, and
  carries the model's `reason`.
- The worker upserts by document id and renders `review.md`, a human-readable
  summary that aggregates suggestions across documents:

```markdown
## Suggested additions (not yet whitelisted)

- documentType "Passport" — 12 docs — "identity document"
  36, 41, 52, ...
- tag "Rechnung" — 3 docs — "German invoice"
  17, 88, 91
```

- `review-log.jsonl` appends one sanitized JSON line per decision for history.

### Automatic Requeue

On each cycle, after reconciliation:

- For each stored document with `status: "review"` and `requeueable: true`,
  check whether every entry in `missing` now resolves to an existing Paperless
  entity.
- In live mode, when all gaps are filled, transition the document from
  `ai-review` back to `ai-pending` (keeping all non-state tags) so the normal
  flow reprocesses it.
- In dry-run mode, report what would be requeued and change nothing.
- Update the store after a successful requeue and increment `attempts`.
- Never requeue a document with `requeueable: false`. Never requeue a document
  whose gaps remain unfilled. Rate-limit repeated requeues to avoid loops.

## Error And Retry Rules

Errors fall into two practical categories:

- Transient: timeouts, connection failures, rate limits, and retryable upstream
  server errors.
- Permanent for the current attempt: invalid model output, unusable OCR,
  unresolved metadata, configuration errors, and non-retryable API responses.

Use bounded in-process retries with backoff for each request and claimed
document. If retries for a claimed document are exhausted, transition it to
`ai-failed` and log the category and retry count. Validation or classification
problems that a human can resolve transition to `ai-review` rather than
`ai-failed`. Invalid model output and unusable OCR are review outcomes in the
initial MVP because a human may still classify the document; this can be
revised after observing real failures.

Every `ai-review` outcome must be recorded in the review artifact with its
reasons and whether it is automatically requeueable. Only vocabulary-gap reviews
are requeueable; model uncertainty, ambiguity, invalid output, and unusable OCR
are not.

Paperless or the LLM service being unavailable leaves the worker running and
retrying with capped backoff. These service-connectivity retries may continue
indefinitely, but each individual request and claimed-document attempt remains
bounded. Invalid local configuration should stop the process immediately.

Because Paperless updates and state transitions may not be transactional:

- Prefer the smallest Paperless update that applies metadata and tags together
  when the API supports it.
- Make repeated updates no-ops where possible.
- Log separately whether metadata and final state were applied.
- Re-fetch current metadata before retrying a write.
- Do not claim transactional guarantees that Paperless does not provide.

Stale `ai-processing` recovery is required before unattended deployment, but
not before the first read-only vertical slice. Its behavior must be based on
confirmed Paperless timestamp semantics. Terminal-state reprocessing remains a
separate manual action.

## Privacy And Logging

Log structured, readable events to stdout. Include document ID, state, timing,
model, prompt version, proposed or applied fields, review reason, error
category, and retry information where relevant.

Do not log:

- API tokens or keys
- Full OCR text
- Full prompts containing OCR text
- Raw upstream responses containing document content
- Personal information that is not needed to diagnose behavior

Document clearly that OCR text is sent to the configured LLM provider.

The review artifact files in the mounted data directory contain derived document
metadata (proposed titles, correspondents, and tags), not OCR text. They are
git-ignored and must be treated as personal data: never commit or ship them.

## Minimal Code Boundaries

The initial implementation should need only a few direct boundaries:

- Configuration loading and validation
- Whitelist loading, validation, and reconciliation
- Paperless HTTP operations
- [OI] request and response handling
- Pure validation and metadata-decision logic
- Review artifact storage and rendering
- Processing one document
- Polling, retry, shutdown, and logging

These boundaries are guidance for cohesion and testing, not required interfaces
or classes. Start with the simplest files that keep the control flow readable.

## Testing Strategy

Use `bun test` and prioritize tests that protect unsafe write behavior:

- Configuration parsing and defaults
- Whitelist validation, aliases, and colliding or ambiguous names
- Contract `proposal-v2` validation, including suggestions
- Normalized and ambiguous metadata matching against the whitelist
- Existing metadata protection and overwrite behavior
- State eligibility and transitions
- Automatic requeue decisions (requeueable vs. not, gaps filled or not)
- Review artifact upsert and rendering
- Reconciliation idempotency and dry-run creating nothing
- Dry-run producing no mutations
- Retry classification
- Idempotent no-op decisions
- Representative Paperless response parsing

HTTP behavior should use mocked `fetch` responses or an equally small test
boundary. Tests must not require real credentials or live services. Keep
fixtures small and stripped of personal data.

## Milestones

### M0: Planning And API Contract

Establish only the project commands and configuration needed for a one-document
dry-run, confirm the Paperless and LLM API calls needed for that path, and
capture representative sanitized responses as fixtures.

Exit condition: implementation can begin without guessing endpoint paths,
authentication, response fields, or the LLM response shape.

### M1: Local Read-Only Vertical Slice

Run locally in dry-run mode against real services. Find one pending document,
read OCR and metadata, classify it, validate and resolve the result, and log the
proposed update without changing Paperless.

Exit condition: at least one deliberately selected real document completes the
workflow with zero Paperless mutations.

### M2: Safe Local Write Path And Review Loop

Add the authoritative whitelist, whitelist reconciliation (entity creation in
live mode only), live claiming, pre-update re-fetching, safe metadata updates,
terminal state transitions, the review artifact, and automatic requeue of
review documents whose gaps are filled. Upgrade the model contract to
`proposal-v2`. Exercise the path using deliberately selected test documents.

Exit condition: a test document reaches processed, review, and failed outcomes
as expected; whitelisted entities are created idempotently; a review document is
automatically requeued once its missing entities are added to the whitelist and
reconciled; and no user metadata is removed and no non-whitelisted entity is
created.

### M3: Operational Minimum

Add continuous polling, bounded retries, graceful shutdown, periodic vocabulary
and whitelist refresh, stale-processing recovery, and the focused automated test
suite needed for unattended use. Reconciliation and requeue already exist from
M2; M3 makes them run continuously and safely.

Exit condition: the local worker can run continuously and recover predictably
from expected upstream failures.

### M4: Packaging And Distribution

Add Docker, Unraid guidance, devenv, CI, GHCR publishing, README, AGENTS.md, and
release documentation after the application behavior is proven. The image mounts
the data directory so `whitelist.json`, `review.json`, and `review.md` are
reachable from the host filesystem.

Exit condition: a versioned image can be built, published, and run on Unraid
with a mounted data directory, without depending on the local development
environment.

## Open Decisions

These should be answered through API investigation or the first real trial,
not speculative design:

- ~~Exact Paperless-ngx v3 beta build and API response shapes~~ Resolved in M0:
  Paperless-ngx 3.0.0 (OpenAPI 6.0.0), recorded in `docs/api-notes.md`.
- ~~Selected [OI]-compatible provider, model, and supported structured-output
  mode~~ Resolved in M0: `deepseek-v4.1-flash`; `json_schema` strict is
  supported. See `docs/api-notes.md`.
- ~~Exact OCR retrieval field or endpoint~~ Resolved in M0: `content` on
  `GET /api/documents/{id}/`.
- ~~Whether one Paperless update can atomically apply metadata and state tags~~
  Resolved in M0: `PATCH /api/documents/{id}/` accepts `title`, `correspondent`,
  `document_type`, and `tags` together.
- ~~Whether to build a review UI~~ Resolved by decision: no UI. The review
  workflow is a human-edited `whitelist.json` plus a generated `review.md` /
  `review.json` in the mounted data directory.
- ~~Which Paperless timestamp, if any, is reliable for stale-processing
  recovery~~ Resolved in M3: stale recovery uses the always-present
  `document.modified` timestamp, with a documented limitation that it reflects
  any change. The optional `GET /api/documents/{id}/history/` audit endpoint
  records exact state-tag transition times but is not depended on. See
  `docs/api-notes.md`.
- Final timeout, retry, polling, vocabulary refresh, and OCR limit defaults.
  M0 finding: `AbortSignal.timeout` alone did not reliably bound the whole
  request, so the client enforces a hard whole-operation timeout.
- Whether the model performs better with whitelist descriptions and aliases than
  with names alone. The M0/M1 trial used names only; `proposal-v2` adds
  suggestions and optional descriptions.
- Whether per-document overrides belong in a future `decisions.json` control
  file or stay a manual Paperless edit. Deferred.

Any discovery that changes a safety invariant requires updating this plan
before implementation proceeds.
