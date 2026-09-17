# Paperless Curator

A small Bun and TypeScript worker that reads OCR text from
[Paperless-ngx](https://docs.paperless-ngx.com/) and asks an OpenAI-compatible
LLM to suggest document metadata (title, tags, correspondent, and document
type). It applies only values from a human-curated whitelist, never removes
document tags, and never modifies document contents.

> **Safety first.** Dry-run is the default. Live writes require **both**
> `"dryRun": false` in the configuration **and** the `--live` flag. The worker
> never deletes documents or metadata, and it never creates tags,
> correspondents, or document types that are not in your whitelist.

## How it works

1. Poll Paperless for one eligible document (tagged `ai-pending` and no other
   state tag).
2. Read its OCR text and current metadata through the API.
3. Ask one configured LLM for a `proposal-v2` object, offering only whitelist
   names, aliases, and descriptions as allowed choices.
4. Validate the proposal locally and resolve every name to a Paperless id.
   Names that resolve to nothing are recorded as suggestions for review and are
   never applied.
5. In live mode, claim the document (`ai-processing`), re-fetch it, apply the
   smallest safe update, and set the terminal state (`ai-processed`,
   `ai-review`, or `ai-failed`). In dry-run mode, log the proposal and make zero
   Paperless mutations.

Documents that need a human decision are written to `review.json` and rendered
as `review.md` in the data directory. When the only blockers were missing
whitelist entities and those entities now exist, the worker requeues the
document automatically.

## Requirements

- A reachable Paperless-ngx instance and an API token.
- An OpenAI-compatible chat-completions endpoint and API key.
- The five state tags must already exist in Paperless (see
  [State tags](#state-tags)).
- Locally: [Bun](https://bun.sh/) **1.3.13** or newer. There are no runtime
  dependencies.

## Quick start (local)

```sh
cp config.example.json config.json
cp whitelist.example.json whitelist.json
mkdir -p data
mv whitelist.json data/whitelist.json

export PAPERLESS_API_TOKEN="..."
export LLM_API_KEY="..."
# edit config.json: paperless.baseUrl, llm.baseUrl, llm.model

bun run dev                 # continuous polling, dry-run
bun run dev -- --once       # a single cycle
bun run dev -- --document-id 34
```

`config.json`, `whitelist.json`, and `data/` are git-ignored. Never commit
them.

## Configuration

Configuration is one versioned JSON file (`config.example.json` is the
documented example). Invalid configuration is a fatal startup error with an
actionable message. See `PLAN.md` for the full contract.

| Key | Default | Notes |
| --- | --- | --- |
| `paperless.baseUrl` | required | Paperless base URL |
| `llm.baseUrl` | required | OpenAI-compatible base URL (include `/v1` if needed) |
| `llm.model` | required | Model name |
| `stateTags` | `ai-pending`, `ai-processing`, `ai-processed`, `ai-review`, `ai-failed` | Must exist in Paperless; distinct |
| `dryRun` | `true` | Set `false` **and** pass `--live` to write |
| `overwrite.title` / `.correspondent` / `.documentType` | `false` | Overwrite non-empty values |
| `limits.maxTitleLength` | `128` | Paperless caps titles at 128 |
| `limits.maxOcrChars` | `30000` | OCR is truncated from both ends |
| `request` | `30000` / `2` / `1000` | timeout ms / retries / backoff ms |
| `operations.pollIntervalMs` | `60000` | Delay between one-document cycles |
| `operations.vocabularyRefreshMs` | `900000` | Whitelist + vocabulary refresh |
| `operations.staleProcessingThresholdMs` | `900000` | Live-only stale recovery |
| `operations.backoff` | `{ "initialMs": 1000, "maxMs": 60000 }` | Service-connectivity backoff |
| `dataDir` | `./data` | Overridden by `DATA_DIR` |

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `PAPERLESS_API_TOKEN` | yes | Paperless API token |
| `LLM_API_KEY` | yes | LLM API key |
| `CONFIG_PATH` | no | Path to config JSON (default `config.json`) |
| `DATA_DIR` | no | Overrides `config.dataDir` (default `./data`) |

### Data directory

All durable and human-edited files live in one directory (the volume mount in
Docker):

- `whitelist.json` — human-curated metadata vocabulary (you edit this).
- `review.json` — worker-managed review store.
- `review.md` — human-readable review view.
- `review-log.jsonl` — append-only decision history.

These files contain **derived personal metadata** (proposed titles,
correspondents, and tags), not OCR text. Treat them as personal data: never
commit or ship them.

## State tags

The worker tracks processing with five pre-existing Paperless tags:

```text
pending -> processing -> processed
                      -> review
                      -> failed
```

All five counts toward eligibility: a document is processed only when it has
the pending tag and none of the other four. Conflicting state tags are logged
and skipped, never repaired automatically. Missing or duplicated state tags
block processing (the process stays alive and retries) until you fix them in
Paperless. The worker never creates state tags.

## Dry-run is the default

Dry-run performs **zero** Paperless mutations, including state-tag changes and
whitelist entity creation. It reports what it would create, update, or requeue.
Because dry-run cannot claim documents, do not run a dry-run and a live worker
against the same Paperless instance at the same time.

## Whitelist and review workflow

The whitelist is the model's only source of allowed values, and the only source
from which the worker may create Paperless entities:

```json
{
  "version": 1,
  "tags": [
    { "name": "Invoice", "aliases": ["Rechnung"], "description": "Bills" }
  ],
  "correspondents": [],
  "documentTypes": []
}
```

When a document cannot be resolved, the worker writes a review artifact with
the proposal, the reasons, and every missing entity plus the model's reason.
Open `review.md` to see aggregated suggestions. Add the ones you agree with to
`whitelist.json`; reconciliation creates them in Paperless (live mode) and
requeueable documents are processed again automatically. See `review.json` for
per-document detail.

## Privacy

**OCR text is sent to the configured LLM provider.** Do not run this if your
documents must not leave your infrastructure, or point `llm.baseUrl` at a
provider you trust. Only a bounded excerpt (up to `limits.maxOcrChars`) is
sent. Logs never contain secrets, full OCR text, full prompts, or raw upstream
responses.

## Docker

The image is a multi-stage build with a pinned Bun version. It contains only
the bundled worker, runs as a non-root user (`bun`, uid 1000), exposes **no
ports**, and needs only outbound access to Paperless and the LLM endpoint.

Build locally:

```sh
docker build -t paperless-curator:local .
```

Run with a mounted data directory:

```sh
mkdir -p appdata
cp config.example.json appdata/config.json
cp whitelist.example.json appdata/whitelist.json
# edit appdata/config.json, then make it writable by the container user
chown -R 1000:1000 appdata

docker run -d \
  --name paperless-curator \
  --restart unless-stopped \
  -v "$PWD/appdata":/data \
  -e PAPERLESS_API_TOKEN="..." \
  -e LLM_API_KEY="..." \
  paperless-curator:local
```

- `/data` is the data directory (`CONFIG_PATH=/data/config.json`,
  `DATA_DIR=/data` are set in the image).
- There is no `-p`; the worker only makes outbound requests.
- The container user must be able to write `/data` (the `chown` above).
- `paperless.baseUrl` must be reachable **from inside the container**. On the
  same host, use the host's LAN IP, not `localhost`.

Published images (once released) are at
`ghcr.io/rodogir/paperless-curator:<version>`.

## Unraid

1. Create the appdata directory and copy in the example config and whitelist:

   ```sh
   mkdir -p /mnt/user/appdata/paperless-curator
   cp config.example.json /mnt/user/appdata/paperless-curator/config.json
   cp whitelist.example.json /mnt/user/appdata/paperless-curator/whitelist.json
   chown -R 1000:1000 /mnt/user/appdata/paperless-curator
   ```

2. Edit `config.json`: set `paperless.baseUrl` and `llm.baseUrl`. If Paperless
   runs on the same Unraid box, use its LAN address (for example
   `http://192.168.1.10:8000`), not `localhost`.

3. Add a container with:
   - **Repository:** `ghcr.io/rodogir/paperless-curator:0.1.0` — prefer a
     **versioned tag** over `latest` so upgrades are deliberate.
   - **Network:** Bridge, with **no port mappings**.
   - **Path:** `/mnt/user/appdata/paperless-curator` → `/data`.
   - **Variables:** `PAPERLESS_API_TOKEN`, `LLM_API_KEY`.
   - **Restart policy:** unless stopped.

4. Watch the container log for `startup` and `cycle-complete` events. Review
   `review.md` in the appdata directory as documents are classified.

To upgrade, pull the new version tag and restart; the data directory is
preserved. Read the release notes before changing a major or minor version.

## Troubleshooting

| Log event / symptom | Meaning | Fix |
| --- | --- | --- |
| `config-error ... is not set` | A required secret is missing | Export `PAPERLESS_API_TOKEN` / `LLM_API_KEY` |
| `config-error` / `whitelist-error` | Invalid JSON/config/whitelist | Read the message; the worker exits on startup errors |
| `state tags invalid` | A state tag is missing or duplicated in Paperless | Create/rename the five tags |
| `refresh-failed` (transient) | Paperless or LLM unreachable | The worker stays up and retries with capped backoff |
| `cycle-failed` (transient) | A transient upstream error | Retried automatically; check connectivity |
| `cycle-complete` with `status: review` | A human decision is needed | Read `review.md`; add whitelist entries |
| `Permission denied` writing review files | Container cannot write the mount | `chown -R 1000:1000` the appdata directory |
| Nothing happens in dry-run | Expected | Dry-run makes no changes; set `dryRun=false` and pass `--live` |

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Canonical commands: `bun run check`,
`bun test`, `bun run build`. `AGENTS.md` and `PLAN.md` describe the design and
safety invariants; read them before changing behavior.
