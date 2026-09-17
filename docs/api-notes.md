# Confirmed API Behavior (M0)

These notes record what was verified against the real services before M1 client
code was finalized. They intentionally contain no tokens, hostnames beyond the
documented base URLs, OCR text, or personal document data.

## Paperless-ngx

- Build: `pngx_version` **3.0.0**, `install_type: docker`, `database.type:
  sqlite`.
- OpenAPI document: `GET /api/schema/?format=json`, `info.version` **6.0.0
  (10)**.
- Latest applied migration: `documents.0022_add_perf_indexes`.
- Reachability probe: `GET /api/status/` returns the fields above.

### Authentication

Header `Authorization: Token <PAPERLESS_API_TOKEN>` on every request. A missing
or invalid token yields `401`, which is treated as a permanent failure.

### Pagination

Collection endpoints return:

```json
{ "count": 65, "next": null, "previous": null, "results": [...], "display_count": 65 }
```

`next` is an absolute URL or `null`. Clients follow `next` until `null` and use
`page_size` to bound the number of pages.

### Vocabulary endpoints

- `GET /api/tags/`
- `GET /api/correspondents/`
- `GET /api/document_types/`

Each result entry has at least `id` (integer) and `name` (string). Tag entries
also include `slug`, `is_inbox_tag`, and `document_count`. Correspondents and
document types include `slug` and `document_count`.

### Document listing and filtering

`GET /api/documents/` supports:

- `tags__id__all=<id>` — documents carrying all of the given tag ids.
- `tags__id__none=<id,id>` — documents carrying none of the given tag ids.
- `fields=<csv>` — response projection. Verified with
  `id,title,tags,correspondent,document_type,created`.
- `ordering=<field>` — free-form model field ordering.
- `page`, `page_size`.

Confirmed response shape with the projection above:

```json
{ "id": 34, "correspondent": null, "document_type": null,
  "title": "DocScanner Sep 3, 2026 15-38", "tags": [70], "created": "2026-09-03" }
```

Important: `tags` is an **array of integer ids** in both list and detail
responses. `correspondent` and `document_type` are integer ids or `null`.

### Document detail and OCR

`GET /api/documents/{id}/` includes `content`, which is the OCR text. It also
includes read-only `modified` (ISO-8601 timestamp), `added`, `original_file_name`,
`page_count`, `mime_type`, and `archive_serial_number`.

### Document updates

`GET /api/schema/` lists `/api/documents/{id}/` methods as
`delete`, `get`, `patch`, `put`. `PATCH` accepts any subset of writable fields,
so metadata (`title`, `correspondent`, `document_type`) and `tags` can be
updated in **one request**. `content`, `modified`, `added`, `original_file_name`,
`page_count`, and `mime_type` are read-only.

`title` has `max_length` **128**. The application therefore caps
`maxTitleLength` at 128; generating a longer title would be rejected by the API.

`correspondent`, `document_type`, and `storage_path` are marked required in the
write serializer but currently accept `null`.

### State tags

All five configured tags exist: `ai-failed`, `ai-pending`, `ai-processed`,
`ai-processing`, `ai-review`. Tags are resolved by normalized name at runtime;
ids are not hardcoded.

### Document update timestamps and history (M3)

Confirmed read-only against the same 3.0.0 build.

- `GET /api/documents/{id}/` exposes read-only `modified` (ISO-8601
  `date-time`) and `added`. `modified` changes on every `PATCH`, including the
  worker's own claim and terminal-state updates; because the audit log records
  matching timestamps, `modified` can be treated as "the document has not
  changed since this time".
- The `fields` projection was extended to `id,tags,modified`. A tag-filtered
  list (`GET /api/documents/?tags__id__all=<id>&fields=id,tags,modified`) returns
  every requested field, so stale-processing detection needs no extra detail
  request.
- `GET /api/documents/{id}/history/` returns audit entries. Contrary to the
  OpenAPI schema (`PaginatedLogEntryList`), the installed build returns a bare
  JSON **array**, newest first. Each entry has `id`, `timestamp` (ISO-8601
  `date-time`), `action`, `changes`, and `actor`.
- Tag transitions are recorded as
  `changes.tags = { "type": "m2m", "operation": "add" | "delete", "objects": [names] }`.
  A sanitized example from the M2 test document showed, in order: delete
  `ai-pending`, add `ai-processing` (the claim), then delete `ai-processing`
  and add `ai-processed`, each with its own timestamp. Exact state-change times
  are therefore available when Paperless audit logging is enabled.
- The audit log is an optional signal: it depends on the server's audit-log
  setting, is permission-gated, and the response shape differs from the schema.
  The worker therefore does **not** depend on it.

Open decision resolved: which Paperless timestamp is reliable for
stale-processing recovery?

- **Chosen: `document.modified`.** It is always present, needs no extra request
  or permission, and is updated by the claim. A document that still carries
  `ai-processing` with `modified` older than the threshold is recovered.
- **Limitation:** `modified` reflects the most recent change of any kind, so an
  unrelated concurrent edit restarts the clock and can delay recovery. It does
  not identify the claim event specifically. This is acceptable because
  multi-instance operation is unsupported, the worker only recovers while idle
  between cycles, and the threshold is far larger than any bounded cycle.
- **Available but unused:** `GET /api/documents/{id}/history/` gives the exact
  `ai-processing` add time, but is optional and would cost one request per
  candidate. It is recorded here as a future refinement, not a dependency.

### Entity creation endpoints (M2)

Confirmed from `GET /api/schema/?format=json` (`info.version` 6.0.0) on the same
3.0.0 build:

- `POST /api/tags/` (`tags_create`, request `TagRequest`)
- `POST /api/correspondents/` (`correspondents_create`, request
  `CorrespondentRequest`)
- `POST /api/document_types/` (`document_types_create`, request
  `DocumentTypeRequest`)

Each request body requires only `name`:

```json
{ "name": "Example" }
```

- `name` is a string with `minLength` 1 and `maxLength` 128. The worker sends
  `name` and no other field; defaults apply server-side.
- Optional fields the worker does not send include `match`, `matching_algorithm`,
  `is_insensitive`, `owner`, and `set_permissions`; tags additionally accept
  `color`, `is_inbox_tag`, and `parent`.
- Success is `201` with the created object. The response exposes at least
  `id` (integer) and `name` (string), plus read-only `slug`, `document_count`,
  and `user_can_change`. The worker reads back only `id` and `name`.

Live confirmation (M2 checkpoint): all three endpoints returned `201` with the
created `id` and `name` for whitelisted names, and a repeated cycle created
nothing. Duplicate-name behavior was **not** probed by deliberately posting an
existing name, because that could create a duplicate entity outside the
whitelist. The worker must not depend on the API to reject duplicates;
idempotency comes from re-resolving the name against a freshly listed vocabulary
immediately before creating.

## OpenAI-compatible LLM endpoint

- Base URL: `https://api.surplusintelligence.ai/v1`.
- `GET /models` returns 406 models including `deepseek-v4.1-flash`.
- `POST /chat/completions`:

  - Required headers: `Authorization: Bearer <LLM_API_KEY>`,
    `Content-Type: application/json`.
  - Body: `model`, `messages`, optional `temperature`.
  - `response_format: { "type": "json_object" }` is accepted and returns a JSON
    string in `choices[0].message.content`.
  - `response_format` with `{ "type": "json_schema", "json_schema": { name,
    strict: true, schema } }` is accepted. This is the mode the worker uses so
    the provider enforces the shape; the application still validates locally.
  - Errors use the OpenAI shape:
    `{ "error": { "type", "code", "message" }, "request_id" }`. An unknown model
    returns `404` with `code: "no_sellers_for_model"`.
  - Rate-limit headers are present: `x-ratelimit-limit`, `x-ratelimit-remaining`,
    `x-ratelimit-reset`.

### Response contract (prompt `proposal-v2`)

```json
{
  "title": "string, non-empty",
  "tags": ["names to add, from the allowed whitelist"],
  "correspondent": "name from the allowed whitelist, or null",
  "document_type": "name from the allowed whitelist, or null",
  "review": false,
  "review_reasons": [],
  "suggested_tags": [{ "name": "Passport", "reason": "identifies a passport" }],
  "suggested_correspondent": { "name": "Consulate", "reason": "issuer" },
  "suggested_document_type": { "name": "Passport", "reason": "identity document" }
}
```

- `title`, `tags`, `correspondent`, and `document_type` may only reference the
  offered whitelist values; the application resolves aliases to canonical names.
- `suggested_tags`, `suggested_correspondent`, and `suggested_document_type`
  capture values absent from the whitelist. They are never applied; they become
  `missing` entities in the review artifact.
- All fields are required. `correspondent`, `document_type`, and each suggestion
  object may be `null`; the suggestion arrays may be empty.

Numeric confidence is not requested. The application resolves every name to a
Paperless id and decides whether an update is safe.
