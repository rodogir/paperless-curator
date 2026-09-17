# Paperless Curator Task List

This is the execution checklist for implementation sessions. Complete tasks in
milestone order unless a dependency requires otherwise. Keep M0 through M2
focused on proving the local end-to-end workflow; do not pull deployment work
forward.

Status markers:

- `[ ]` not started
- `[~]` in progress
- `[x]` completed
- `[-]` intentionally deferred or cancelled

When completing a task, add a short note or link to the relevant commit, pull
request, fixture, or documentation section when that context will help the next
session.

## M0: Planning And API Contract

### Project Baseline

- [x] Add a minimal Bun and TypeScript project scaffold.
  - Define canonical package commands for development, formatting or checking,
    type checking, testing, and building.
  - Pin the Bun version and dependency versions.
  - Add only dependencies justified by immediate MVP functionality.
  - Verify a trivial build and `bun test` run locally.
  - Done: `package.json` defines `dev`, `format`, `check`, `typecheck`, `test`,
    and `build`, plus `lint`. Pinned devDependencies: `typescript@7.0.2`,
    `@types/bun@1.4.2`, `@biomejs/biome@2.5.14`. No runtime dependencies.
    `engines.bun`
    pins `>=1.3.13`. `bun run build`, `bun test`, and `tsc --noEmit` all pass.
- [x] Add a versioned example configuration and a local ignored configuration
  path.
  - Initially include Paperless URL, LLM base URL and model, state tags,
    dry-run, overwrite flags, request timeout, and text limits.
  - Defer polling, vocabulary refresh, and operational retry configuration until
    M3; use the conservative defaults in `PLAN.md` until then.
  - Keep `PAPERLESS_API_TOKEN` and `LLM_API_KEY` in environment variables.
  - Add or confirm ignore rules for secrets and local configuration.
  - Done: `config.example.json` is versioned; `config.json` is the local,
    git-ignored default (`CONFIG_PATH` overrides it). `.gitignore` ignores
    `config.json`, `config.*.local.json`, and `.env*` (except `.env.example`).
- [x] Implement startup configuration parsing and validation.
  - Reject unsupported configuration versions and invalid values.
  - Apply documented defaults.
  - Produce actionable errors without printing secrets.
  - Add focused configuration tests.
  - Done: `src/config.ts` (`parseConfig`, `loadConfig`) validates version,
    URLs, distinct state tags, and numeric bounds; `maxTitleLength` is capped at
    Paperless' 128. Covered by `tests/config.test.ts`.

### Paperless API Investigation

- [x] Record the exact Paperless-ngx v3 beta build used for initial testing.
  - Done: `pngx_version` 3.0.0 (docker, sqlite), OpenAPI `info.version`
    6.0.0 (10), latest migration `documents.0022_add_perf_indexes`.
    See `docs/api-notes.md`.
- [x] Confirm authentication and the API operations required for the vertical
  slice against the installed instance or its matching API schema.
  - List and paginate tags.
  - List and paginate correspondents.
  - List and paginate document types.
  - Filter documents by the pending tag.
  - Fetch one document's metadata and OCR content.
  - Update document metadata and tags.
  - Determine whether metadata and state tags can be updated together.
  - Done: `Authorization: Token` header; pagination via `next`; document
    filtering via `tags__id__all`/`tags__id__none` and `fields`; OCR in
    `content`; `PATCH` accepts metadata and `tags` in one request. Recorded in
    `docs/api-notes.md`.
- [x] Capture minimal sanitized response fixtures for the confirmed endpoints.
  - Remove OCR content, tokens, hostnames, and personal data.
  - Keep only fields the application consumes plus representative pagination.
  - Done: `fixtures/paperless/*.json` with fictional names, `paperless.invalid`
    hosts, and OCR replaced by a placeholder. See `fixtures/README.md`.

### LLM API Investigation

- [x] Select the first [OI]-compatible provider and model used for real testing.
  - Done: `deepseek-v4.1-flash` at the configured OpenAI-compatible base URL.
- [x] Confirm the smallest supported request format and structured-output mode.
  - Record the endpoint path and required headers.
  - Confirm timeout and error response behavior relevant to retries.
  - Do not add provider-specific options unless needed for the selected service.
  - Done: `POST /chat/completions`, `Authorization: Bearer`, strict
    `json_schema` `response_format`. Errors use the OpenAI shape; rate-limit
    headers present. See `docs/api-notes.md`.
- [x] Define and version the initial prompt and response contract.
  - Require title, tags to add, optional correspondent, optional document type,
    review decision, and review reasons.
  - Decide whether allowed choices include names only or names and IDs based on
    the first trial.
  - Keep numeric confidence out unless testing shows a concrete need.
  - Done: `proposal-v1` in `src/prompt.ts` and `src/llm.ts`; names only; local
    validation via `parseProposal`.
- [x] Add sanitized valid and invalid LLM response fixtures.
  - Done: `fixtures/llm/proposal-valid.json` and
    `fixtures/llm/proposal-invalid.json`.

### M0 Verification

- [x] Run the canonical checks and tests.
  - Done: `bun run check` (Biome + `tsc --noEmit`), `bun test` (57 tests),
    `bun run build`.
- [x] Verify no secret, real OCR text, or personal document data is tracked.
  - Done: fixtures use fictional data and placeholders; `config.json` and
    `.envrc.local` are git-ignored.
- [x] Update `PLAN.md` if API findings invalidate any assumption.
  - Done: title limit corrected from 200 to 128 and Open Decisions updated with
    M0 findings.
- [x] Confirm readiness for M1: no required endpoint or response shape remains
  guessed.
  - Done: endpoints, auth, pagination, filters, OCR field, update method, and
    the `proposal-v1` contract are recorded in `docs/api-notes.md`.

## M1: Local Read-Only Vertical Slice

### Minimal Clients

- [x] Implement direct Paperless HTTP functions for only the confirmed M1 API
  operations.
  - Use the configured token without logging it.
  - Enforce request timeouts.
  - Handle pagination for metadata vocabularies and document selection.
  - Parse untrusted responses at the boundary.
  - Avoid a generic SDK or class hierarchy.
  - Done: `src/paperless.ts` with `listTags`, `listCorrespondents`,
    `listDocumentTypes`, `listPendingDocuments`, `getDocument`, `getStatus`.
    `src/http.ts` enforces a hard whole-request timeout and transient-only
    retries.
- [x] Implement the direct [OI]-compatible request function.
  - Send bounded OCR content and allowed metadata choices.
  - Include a prompt version in logs.
  - Parse and validate the structured response locally.
  - Avoid logging prompts, OCR, keys, or raw sensitive responses.
  - Done: `src/llm.ts` (`callModel`, `parseProposal`) and `src/prompt.ts`
    (`PROMPT_VERSION = "proposal-v1"`). Errors and logs never include prompts,
    OCR, keys, or raw payloads.

### First Happy Path

- [x] Connect the two clients in a one-document dry-run as soon as their basic
  response boundaries work.
  - Fetch one pending document, its OCR, and the available metadata.
  - Call the model and log the parsed proposal.
  - Make zero Paperless mutation requests.
  - Use this early run to expose incorrect API assumptions before completing
    all edge-case rules below.
  - Done: `bun run src/index.ts --document-id 34` produced a proposal against
    the real services; `tests/dryrun.test.ts` proves only Paperless `GET`
    requests are sent.

### Pure Decision Logic

- [x] Implement OCR preparation.
  - Reject empty or unusable text.
  - Apply the configured length limit deterministically.
  - Preserve content from the beginning and end when truncating.
  - Report truncation as metadata for logging.
  - Done: `prepareOcr` in `src/text.ts`; tested in `tests/text.test.ts`.
- [x] Implement title normalization and validation.
  - Normalize whitespace.
  - Reject empty values, control characters, and overlong titles.
  - Done: `validateTitle` in `src/text.ts`.
- [x] Implement metadata vocabulary normalization and resolution.
  - Trim, Unicode-normalize, and compare names case-insensitively.
  - Reject unknown and ambiguous matches.
  - Exclude configured worker-state tags from selectable document tags.
  - Done: `src/metadata.ts` (`normalizeName`, `resolveName`,
    `resolveStateTags`, `excludeStateTags`); tested in `tests/metadata.test.ts`.
- [x] Implement the proposed-change decision.
  - Preserve existing document tags.
  - Treat duplicate tag suggestions as no-ops.
  - Populate empty title, correspondent, and document type values.
  - Respect overwrite flags for non-empty values.
  - Convert unsafe, unresolved, or highly uncertain outcomes to review.
  - Return explicit proposed changes and reasons without performing I/O.
  - Done: `decideChanges` in `src/decision.ts`; never removes tags and never
    selects state tags. Tested in `tests/decision.test.ts`.
- [x] Add focused `bun test` coverage for mutation safety, matching ambiguity,
  metadata protection, and response validation; add further cases when a
  concrete failure risk justifies them.
  - Done: 57 tests across 8 files, including `tests/dryrun.test.ts`.

### Dry-Run Orchestration

- [x] Implement selection of one eligible document.
  - Require pending and reject documents containing another worker-state tag.
  - Log conflicting state tags without repairing them.
  - Done: `checkEligibility` in `src/paperless.ts`; conflicting candidates are
    logged and skipped. An optional `--document-id` targets a deliberately
    selected document for a dry run.
- [x] Implement processing of one document in dry-run mode.
  - Fetch OCR and current metadata.
  - Call the LLM.
  - Validate and resolve its response.
  - Log the proposed outcome and duration.
  - Make zero Paperless mutation requests.
  - Done: `src/process.ts`; the module contains no write functions.
- [x] Implement startup behavior for Paperless connectivity.
  - Fail immediately for invalid local configuration.
  - Keep the process running and retry when Paperless is unavailable.
  - Once connected, validate that all configured state tags exist uniquely.
  - Keep the process alive but block document processing while state tags are
    missing or ambiguous; periodically revalidate and rate-limit the actionable
    error log.
  - Done: `resolveStateTagsWithRetry` in `src/index.ts`.
- [x] Add a minimal local command that runs the dry-run worker without Docker.
  - Done: `bun run src/index.ts` (or `bun run dev`).

### M1 Real-Service Checkpoint

- [x] Prepare at least one deliberately selected Paperless test document with
  only the pending state tag.
  - Done: document 34 (`DocScanner Sep 3, 2026 15-38`) carries only
    `ai-pending`. Note: document 10 also carries `ai-pending`; the user chose to
    process only document 34 in the real dry run.
- [x] Run the worker locally against the real Paperless and LLM APIs in dry-run
  mode.
  - Done: `bun run src/index.ts --document-id 34` (twice).
- [x] Confirm from Paperless that no metadata or tags changed.
  - Done: `modified` timestamps, titles, tags, correspondent, document type,
    and the pending document list are byte-identical before/after both runs.
    A test also asserts only Paperless `GET` requests are issued.
- [x] Review the proposed title and metadata for usefulness.
  - Done: across runs the model proposed titles "Passaporte do Brasil" /
    "Passaporte Brasileiro" and either document type "Official Document" or an
    explicit review. The title was preserved because overwrite is disabled. See
    the M1 checkpoint summary.
- [x] Record observed API, prompt, OCR, and logging issues without prematurely
  generalizing the implementation.
  - Done: the model returned no tags in every run and flipped between an
    "Official Document" proposal and `review: true` for the same document;
    provider latency varied 5-66s while the hard 30s timeout held; Paperless'
    real `title` limit is 128.
- [x] Adjust the response contract, prompt, limits, and matching rules only as
  justified by the trial.
  - Done: title limit set to 128; hard whole-request timeout added; retry
    logging added; optional `--document-id` added for a deliberate test target.
- [ ] Confirm readiness for M2 with the user before enabling writes.

## M2: Safe Local Write Path And Review Loop

### Metadata Whitelist

- [ ] Add a versioned `whitelist.example.json` and git-ignore the real
  `whitelist.json` in the mounted data directory.
  - Sections for tags, correspondents, and document types.
  - Each entry has a required `name` and optional `aliases` and `description`.
- [ ] Implement whitelist loading and validation.
  - Reject unsupported versions, empty names, and normalized duplicates within
    each namespace.
  - Reject aliases that collide with another entry's name or alias in the same
    namespace.
  - Reject state tag names and produce actionable errors without secrets.
  - Add focused tests.
- [ ] Offer whitelist canonical names and descriptions to the model, and resolve
  model output against canonical names and aliases.

### Whitelist Reconciliation

- [ ] Confirm the Paperless entity-creation endpoints
  (`POST /api/tags/`, `/api/correspondents/`, `/api/document_types/`) and their
  duplicate-name behavior against the real instance; record sanitized findings
  in `docs/api-notes.md` before relying on them.
- [ ] Reconcile the whitelist against Paperless on each cycle.
  - Look up each entry by normalized name.
  - In live mode, create missing tags, correspondents, and document types.
  - Make creation idempotent by re-checking before creating.
  - In dry-run mode, report would-create and create nothing.
  - Log each creation by kind and name; a failed creation must not block others.
- [ ] Add tests proving reconciliation is idempotent, never creates
  non-whitelisted entities, and creates nothing in dry-run.

### Contract v2 And Prompt

- [ ] Upgrade the response contract to `proposal-v2`.
  - Keep `title`, `tags`, `correspondent`, `document_type`, `review`, and
    `review_reasons`.
  - Add `suggested_tags`, `suggested_correspondent`, and
    `suggested_document_type`, each with `name` and `reason`.
  - Update the strict `json_schema` and `parseProposal` validation.
- [ ] Update the prompt to explain the whitelist and that suggestions are
  recorded for review and never applied.
- [ ] Update fixtures for valid and invalid `proposal-v2` responses and add
  tests.

### Review Artifact

- [ ] Implement a `review.json` store keyed by document id.
  - Record status, `requeueable`, attempts, current metadata, proposal, review
    reasons, and `missing` entities with reasons.
  - Upsert records idempotently and never store OCR text.
- [ ] Render `review.md` with per-document reasons and aggregated suggestions
  (name, kind, count, document ids, reason).
- [ ] Append sanitized decisions to `review-log.jsonl`.
- [ ] Keep the data directory git-ignored and add tests for upsert, merge, and
  rendering.

### Automatic Requeue

- [ ] Implement pure requeue decisions.
  - Requeue only `status: review` documents whose `requeueable` flag is true.
  - Requeue only when every `missing` entity now resolves to a Paperless entity.
  - Never requeue model uncertainty, ambiguity, invalid output, or unusable OCR.
  - Rate-limit repeated requeues to avoid loops.
- [ ] In live mode, transition requeued documents from `ai-review` to
  `ai-pending` while preserving all non-state tags.
- [ ] In dry-run mode, report would-requeue and change nothing.
- [ ] Add tests for requeueable classification, filled and unfilled gaps, and
  idempotent requeue.

### State And Update Decisions

- [ ] Implement pure live-state transition decisions.
  - Claim: pending to processing.
  - Success: processing to processed.
  - Manual intervention: processing to review.
  - Exhausted technical failure: processing to failed.
  - Never remove non-state document tags.
- [ ] Implement idempotent update construction.
  - Use Paperless IDs.
  - Omit unchanged fields.
  - Preserve existing metadata according to overwrite policy.
  - Keep state tags mutually exclusive in worker-generated updates.
- [ ] Add tests for transitions, no-op updates, and metadata protection.

### Live Processing

- [ ] Add an explicit live-mode guard so writes cannot occur accidentally while
  dry-run is enabled.
- [ ] Implement the ordered live flow: reconcile the whitelist, select, claim,
  fetch authoritative OCR and metadata, invoke the model, resolve the decision,
  re-fetch, recompute the safe update, apply metadata, and apply the terminal
  state.
  - A failed claim makes no model request and leaves recovery to the next poll.
  - Preserve newly observed user tags and recompute overwrite/no-op decisions.
  - Route to review only when a newly populated protected field conflicts with
    the proposed update; otherwise retain it according to overwrite policy.
  - A final-state failure is logged distinctly and handled through idempotent
    re-fetch and retry rather than blindly repeating metadata updates.
- [ ] Apply permitted metadata and the final processed state using the smallest
  safe number of Paperless requests supported by the confirmed API.
- [ ] Handle non-transactional partial failures explicitly.
  - Log metadata application separately from final state application.
  - Re-fetch before retrying a write.
  - Avoid repeating already-applied changes.
- [ ] Route unusable OCR, invalid model output, unknown or ambiguous metadata,
  and high uncertainty to review, recording the review artifact.
- [ ] Retry transient per-document failures with bounded backoff and transition
  to failed after exhaustion.
- [ ] Add mocked HTTP tests proving dry-run sends no mutation requests and live
  mode sends only the expected updates, entity creations, and requeues.

### M2 Real-Service Checkpoint

- [ ] Use disposable or deliberately selected documents to exercise a
  successful processed outcome.
- [ ] Exercise a review outcome caused by a missing whitelist entity and confirm
  the review artifact explains the gap and its reason.
- [ ] Add the missing entity to `whitelist.json`, let reconciliation create it,
  and confirm the document is automatically requeued and then processed.
- [ ] Exercise a controlled technical failure and confirm the failed outcome
  after bounded retries.
- [ ] Verify existing user tags are retained, metadata overwrite rules are
  honored, and no non-whitelisted entity is created.
- [ ] Verify terminal documents are not selected again until reset or requeued.
- [ ] Review real behavior and decide which M3 safeguards are actually needed
  before unattended operation.

## M3: Operational Minimum

Do not expand these tasks until M2 feedback establishes the necessary behavior.

- [ ] Add continuous polling with the configured interval and one-document
  processing.
- [ ] Add graceful shutdown that stops polling and lets the active bounded
  operation finish or abort safely.
- [ ] Add periodic vocabulary refresh and continuous whitelist reconciliation
  (reconciliation and requeue logic exist from M2; M3 runs them on the poll
  loop).
- [ ] Confirm how Paperless exposes document update timestamps and whether they
  are suitable for identifying stale processing states.
- [ ] Design and implement stale-processing recovery using confirmed Paperless
  timestamp behavior and a documented limitation.
- [ ] Finalize transient versus permanent error classification.
- [ ] Ensure each request and document attempt is bounded, while service-level
  connectivity retries may continue indefinitely with capped backoff and no
  tight loops.
- [ ] Add structured stdout logging with document ID, state, timing, model,
  prompt version, changed fields, review reasons, errors, and retries.
- [ ] Run the focused critical test suite and add only tests motivated by real
  failure risks found during M1 and M2.
- [ ] Run the worker locally for an extended trial and document operational
  findings.

## M4: Packaging And Distribution

This milestone is optional until the local application is useful and stable.

- [ ] Add a reproducible multi-stage Docker build using a pinned Bun image.
- [ ] Run the runtime image as a non-root user where practical.
- [ ] Verify the image exposes no ports and needs only configuration, secrets,
  and network access to Paperless and the LLM endpoint.
- [ ] Add a documented data-directory volume mount so `whitelist.json`,
  `review.json`, `review.md`, and `review-log.jsonl` are reachable from the host
  filesystem (Unraid appdata).
- [ ] Add a simple `devenv.nix` that supplies Bun, Git, Docker CLI, and canonical
  project tasks without affecting the production image.
- [ ] Write a concise README covering local use, configuration, privacy, state
  tags, dry-run, the whitelist/review workflow, troubleshooting, Docker, and
  Unraid.
- [x] Add and maintain an `AGENTS.md` with project constraints and canonical
  commands once the repository structure is established.
  - Done: added early at user request; see `AGENTS.md`.
- [ ] Document Conventional Commits in a concise `CONTRIBUTING.md`.
- [ ] Add GitHub Actions for formatting/checking, types, tests, build, and
  optionally a non-publishing Docker build.
- [ ] Add release-tag publishing for
  `ghcr.io/rodogir/paperless-curator:<version>`.
- [ ] Publish `latest` only for stable releases and document that Unraid should
  prefer a versioned tag.
- [ ] Add release and upgrade notes when a second release makes them useful.

## Deferred Backlog

- [ ] Reassess multimodal fallback only after OCR-only limitations are observed
  with real documents.
- [ ] Reassess numeric or per-field confidence only if it enables a concrete,
  testable review threshold.
- [ ] Reassess multi-instance coordination only if more than one worker is
  operationally necessary.
- [ ] Reassess custom fields and other metadata only after the basic classifier
  is useful.
- [ ] Reassess a formal review skill or additional coding standards after the
  first implementation establishes real conventions.
- [ ] Reassess a dedicated review UI or per-document `decisions.json` overrides
  only if the file-based whitelist/review loop proves insufficient.

## Blocker Protocol

An implementation session should stop and ask for clarification when:

- The installed Paperless API contradicts a safety invariant in `PLAN.md`.
- A required write cannot be made without risking removal or overwrite of user
  metadata.
- The selected [OI] endpoint cannot provide reliably parseable structured data.
- Real behavior requires creating entities that are not in the whitelist, or
  accessing document files.
- A proposed dependency or abstraction materially expands the MVP.
- Enabling live writes has not been explicitly approved at the M1 checkpoint.

Routine endpoint details, naming, small file organization choices, and other
reversible implementation decisions should be handled pragmatically and noted
for review rather than blocking progress.
