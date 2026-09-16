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
3. Add the smallest safe Paperless write path.
4. Add only the operational safeguards needed to run the worker reliably.
5. Package and automate the proven application.

When scope or design choices compete, prefer the option that gets the vertical
slice tested sooner without weakening the safety rules in this document.

## MVP Capabilities

The worker will:

- Poll Paperless for one eligible document at a time.
- Read the document's OCR content and current metadata through the API.
- Ask one configured [OI]-compatible model for a title and existing metadata.
- Validate all model output in the application.
- Add existing tags without removing document tags.
- Set or, when explicitly enabled, overwrite the title, correspondent, and
  document type.
- Send documents with unsafe or unresolved results to manual review.
- Track processing with pre-existing Paperless tags.
- Support a dry-run mode that performs no Paperless mutations.
- Log useful processing information without logging OCR content or secrets.

The worker will never:

- Modify document contents.
- Delete documents or metadata.
- Create tags, correspondents, or document types.
- Allow the LLM to call Paperless directly.
- Access Paperless document files through the filesystem.
- Expose a network port.

## Explicit Non-Goals

The initial functional milestones do not include:

- Docker or Unraid packaging.
- GitHub Actions or GHCR publishing.
- A database or durable local state.
- Multi-instance coordination.
- Webhooks, a web UI, or a public HTTP server.
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

Normal settings live in one versioned JSON file. Secrets remain in environment
variables.

Required environment variables:

- `PAPERLESS_API_TOKEN`
- `LLM_API_KEY`

Optional environment variables:

- `CONFIG_PATH`, with a documented default path

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
- Bounded request timeout: 30 seconds
- Two retries after the initial request, with exponential backoff starting at
  one second
- Indefinite service-connectivity retries with backoff capped at 60 seconds

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
in fixtures rather than building broad version compatibility.

The LLM response contract should be a small validated object containing:

- A proposed non-empty title
- Tags to add
- An optional correspondent
- An optional document type
- A review decision for genuinely high uncertainty
- Review reasons when review is requested

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

Reprocessing is an explicit manual action: remove the terminal state and leave
the document with only the pending state tag.

Dry-run mode performs no Paperless mutations, including no state-tag changes.
It may therefore inspect a document that another worker could process. Running
dry-run and live workers concurrently is unsupported.

## Metadata Rules

Paperless is the source of truth for tags, correspondents, and document types.
Fetch complete paginated vocabularies at startup after connectivity is
established, then refresh them periodically.

- Exclude all worker-state tags from tags offered to the model.
- Match suggestions using trimmed, Unicode-normalized, case-insensitive exact
  names.
- Treat multiple normalized matches as ambiguous; never choose arbitrarily.
- Reject unknown or ambiguous metadata and mark the document for review.
- Preserve all existing non-state document tags.
- Adding a tag already present is a no-op.
- Populate an empty title, correspondent, or document type.
- Preserve a non-empty value unless its specific overwrite option is enabled.
- Re-fetch the document before a live update and re-evaluate overwrite rules.
- Treat unchanged values as no-ops.

The model's general uncertainty does not automatically require review. Review
is required when uncertainty is high enough that the model explicitly cannot
classify safely, when a selected metadata value cannot be resolved uniquely,
or when an application validation rule fails.

Title validation initially:

- Trim and normalize whitespace.
- Reject empty titles and control characters.
- Reject titles over the configured maximum.
- Do not attempt subjective semantic scoring in the first version.

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

## Minimal Code Boundaries

The initial implementation should need only a few direct boundaries:

- Configuration loading and validation
- Paperless HTTP operations
- [OI] request and response handling
- Pure validation and metadata-decision logic
- Processing one document
- Polling, retry, shutdown, and logging

These boundaries are guidance for cohesion and testing, not required interfaces
or classes. Start with the simplest files that keep the control flow readable.

## Testing Strategy

Use `bun test` and prioritize tests that protect unsafe write behavior:

- Configuration parsing and defaults
- LLM response validation
- Normalized and ambiguous metadata matching
- Existing metadata protection and overwrite behavior
- State eligibility and transitions
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

### M2: Safe Local Write Path

Add live claiming, pre-update re-fetching, safe metadata updates, and terminal
state transitions. Exercise the path using deliberately selected test
documents.

Exit condition: a test document reaches processed, review, and failed outcomes
as expected without removing user metadata or creating metadata entities.

### M3: Operational Minimum

Add continuous polling, bounded retries, graceful shutdown, periodic vocabulary
refresh, stale-processing recovery, and the focused automated test suite needed
for unattended use.

Exit condition: the local worker can run continuously and recover predictably
from expected upstream failures.

### M4: Packaging And Distribution

Add Docker, Unraid guidance, devenv, CI, GHCR publishing, README, AGENTS.md, and
release documentation after the application behavior is proven.

Exit condition: a versioned image can be built, published, and run on Unraid
without depending on the local development environment.

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
- Which Paperless timestamp, if any, is reliable for stale-processing recovery
- Final timeout, retry, polling, vocabulary refresh, and OCR limit defaults.
  M0 finding: `AbortSignal.timeout` alone did not reliably bound the whole
  request, so the client enforces a hard whole-operation timeout.
- Whether the model performs better with metadata names, IDs, or both. M1 trial
  used names only.

Any discovery that changes a safety invariant requires updating this plan
before implementation proceeds.
