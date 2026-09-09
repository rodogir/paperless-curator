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

- [ ] Add a minimal Bun and TypeScript project scaffold.
  - Define canonical package commands for development, formatting or checking,
    type checking, testing, and building.
  - Pin the Bun version and dependency versions.
  - Add only dependencies justified by immediate MVP functionality.
  - Verify a trivial build and `bun test` run locally.
- [ ] Add a versioned example configuration and a local ignored configuration
  path.
  - Initially include Paperless URL, LLM base URL and model, state tags,
    dry-run, overwrite flags, request timeout, and text limits.
  - Defer polling, vocabulary refresh, and operational retry configuration until
    M3; use the conservative defaults in `PLAN.md` until then.
  - Keep `PAPERLESS_API_TOKEN` and `LLM_API_KEY` in environment variables.
  - Add or confirm ignore rules for secrets and local configuration.
- [ ] Implement startup configuration parsing and validation.
  - Reject unsupported configuration versions and invalid values.
  - Apply documented defaults.
  - Produce actionable errors without printing secrets.
  - Add focused configuration tests.

### Paperless API Investigation

- [ ] Record the exact Paperless-ngx v3 beta build used for initial testing.
- [ ] Confirm authentication and the API operations required for the vertical
  slice against the installed instance or its matching API schema.
  - List and paginate tags.
  - List and paginate correspondents.
  - List and paginate document types.
  - Filter documents by the pending tag.
  - Fetch one document's metadata and OCR content.
  - Update document metadata and tags.
  - Determine whether metadata and state tags can be updated together.
- [ ] Capture minimal sanitized response fixtures for the confirmed endpoints.
  - Remove OCR content, tokens, hostnames, and personal data.
  - Keep only fields the application consumes plus representative pagination.

### LLM API Investigation

- [ ] Select the first [OI]-compatible provider and model used for real testing.
- [ ] Confirm the smallest supported request format and structured-output mode.
  - Record the endpoint path and required headers.
  - Confirm timeout and error response behavior relevant to retries.
  - Do not add provider-specific options unless needed for the selected service.
- [ ] Define and version the initial prompt and response contract.
  - Require title, tags to add, optional correspondent, optional document type,
    review decision, and review reasons.
  - Decide whether allowed choices include names only or names and IDs based on
    the first trial.
  - Keep numeric confidence out unless testing shows a concrete need.
- [ ] Add sanitized valid and invalid LLM response fixtures.

### M0 Verification

- [ ] Run the canonical checks and tests.
- [ ] Verify no secret, real OCR text, or personal document data is tracked.
- [ ] Update `PLAN.md` if API findings invalidate any assumption.
- [ ] Confirm readiness for M1: no required endpoint or response shape remains
  guessed.

## M1: Local Read-Only Vertical Slice

### Minimal Clients

- [ ] Implement direct Paperless HTTP functions for only the confirmed M1 API
  operations.
  - Use the configured token without logging it.
  - Enforce request timeouts.
  - Handle pagination for metadata vocabularies and document selection.
  - Parse untrusted responses at the boundary.
  - Avoid a generic SDK or class hierarchy.
- [ ] Implement the direct [OI]-compatible request function.
  - Send bounded OCR content and allowed metadata choices.
  - Include a prompt version in logs.
  - Parse and validate the structured response locally.
  - Avoid logging prompts, OCR, keys, or raw sensitive responses.

### First Happy Path

- [ ] Connect the two clients in a one-document dry-run as soon as their basic
  response boundaries work.
  - Fetch one pending document, its OCR, and the available metadata.
  - Call the model and log the parsed proposal.
  - Make zero Paperless mutation requests.
  - Use this early run to expose incorrect API assumptions before completing
    all edge-case rules below.

### Pure Decision Logic

- [ ] Implement OCR preparation.
  - Reject empty or unusable text.
  - Apply the configured length limit deterministically.
  - Preserve content from the beginning and end when truncating.
  - Report truncation as metadata for logging.
- [ ] Implement title normalization and validation.
  - Normalize whitespace.
  - Reject empty values, control characters, and overlong titles.
- [ ] Implement metadata vocabulary normalization and resolution.
  - Trim, Unicode-normalize, and compare names case-insensitively.
  - Reject unknown and ambiguous matches.
  - Exclude configured worker-state tags from selectable document tags.
- [ ] Implement the proposed-change decision.
  - Preserve existing document tags.
  - Treat duplicate tag suggestions as no-ops.
  - Populate empty title, correspondent, and document type values.
  - Respect overwrite flags for non-empty values.
  - Convert unsafe, unresolved, or highly uncertain outcomes to review.
  - Return explicit proposed changes and reasons without performing I/O.
- [ ] Add focused `bun test` coverage for mutation safety, matching ambiguity,
  metadata protection, and response validation; add further cases when a
  concrete failure risk justifies them.

### Dry-Run Orchestration

- [ ] Implement selection of one eligible document.
  - Require pending and reject documents containing another worker-state tag.
  - Log conflicting state tags without repairing them.
- [ ] Implement processing of one document in dry-run mode.
  - Fetch OCR and current metadata.
  - Call the LLM.
  - Validate and resolve its response.
  - Log the proposed outcome and duration.
  - Make zero Paperless mutation requests.
- [ ] Implement startup behavior for Paperless connectivity.
  - Fail immediately for invalid local configuration.
  - Keep the process running and retry when Paperless is unavailable.
  - Once connected, validate that all configured state tags exist uniquely.
  - Keep the process alive but block document processing while state tags are
    missing or ambiguous; periodically revalidate and rate-limit the actionable
    error log.
- [ ] Add a minimal local command that runs the dry-run worker without Docker.

### M1 Real-Service Checkpoint

- [ ] Prepare at least one deliberately selected Paperless test document with
  only the pending state tag.
- [ ] Run the worker locally against the real Paperless and LLM APIs in dry-run
  mode.
- [ ] Confirm from Paperless that no metadata or tags changed.
- [ ] Review the proposed title and metadata for usefulness.
- [ ] Record observed API, prompt, OCR, and logging issues without prematurely
  generalizing the implementation.
- [ ] Adjust the response contract, prompt, limits, and matching rules only as
  justified by the trial.
- [ ] Confirm readiness for M2 with the user before enabling writes.

## M2: Safe Local Write Path

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
- [ ] Implement the ordered live flow: select, claim, fetch authoritative OCR
  and metadata, invoke the model, resolve the decision, re-fetch, recompute the
  safe update, apply metadata, and apply the terminal state.
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
  and high uncertainty to review.
- [ ] Retry transient per-document failures with bounded backoff and transition
  to failed after exhaustion.
- [ ] Add mocked HTTP tests proving dry-run sends no mutation requests and live
  mode sends only the expected updates.

### M2 Real-Service Checkpoint

- [ ] Use disposable or deliberately selected documents to exercise a
  successful processed outcome.
- [ ] Exercise a review outcome, especially an unknown or ambiguous
  correspondent or document type.
- [ ] Exercise a controlled technical failure and confirm the failed outcome
  after bounded retries.
- [ ] Verify existing user tags are retained and metadata overwrite rules are
  honored.
- [ ] Verify terminal documents are not selected again until manually reset to
  only the pending state.
- [ ] Review real behavior and decide which M3 safeguards are actually needed
  before unattended operation.

## M3: Operational Minimum

Do not expand these tasks until M2 feedback establishes the necessary behavior.

- [ ] Add continuous polling with the configured interval and one-document
  processing.
- [ ] Add graceful shutdown that stops polling and lets the active bounded
  operation finish or abort safely.
- [ ] Add periodic vocabulary refresh.
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
- [ ] Add a simple `devenv.nix` that supplies Bun, Git, Docker CLI, and canonical
  project tasks without affecting the production image.
- [ ] Write a concise README covering local use, configuration, privacy, state
  tags, dry-run, troubleshooting, Docker, and Unraid.
- [ ] Add and maintain an `AGENTS.md` with project constraints and canonical
  commands once the repository structure is established.
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

## Blocker Protocol

An implementation session should stop and ask for clarification when:

- The installed Paperless API contradicts a safety invariant in `PLAN.md`.
- A required write cannot be made without risking removal or overwrite of user
  metadata.
- The selected [OI] endpoint cannot provide reliably parseable structured data.
- Real behavior requires creating metadata entities or accessing document
  files.
- A proposed dependency or abstraction materially expands the MVP.
- Enabling live writes has not been explicitly approved at the M1 checkpoint.

Routine endpoint details, naming, small file organization choices, and other
reversible implementation decisions should be handled pragmatically and noted
for review rather than blocking progress.
