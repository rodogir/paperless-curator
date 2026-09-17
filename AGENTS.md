# AGENTS.md

Guidance for AI agents and contributors working in this repository. Keep it in
sync with `PLAN.md`, which is the source of truth for design and safety.

## What this is

Paperless Curator is a small Bun and TypeScript worker that uses OCR text from
Paperless-ngx and an OpenAI-compatible LLM to suggest and apply document
metadata, driven by a human-curated metadata whitelist.

Read these before changing behavior:

- `PLAN.md` — design, safety invariants, and milestones
- `TASKS.md` — execution checklist; update status markers as work completes
- `docs/api-notes.md` — confirmed Paperless and LLM API behavior
- `fixtures/README.md` — sanitized test fixtures

## Canonical commands

- `bun run dev` / `bun run start` — run the worker
- `bun run format` — write formatting with Prettier
- `bun run check` — Prettier check plus `tsc --noEmit`
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — Bun test runner
- `bun run build` — bundle to `dist/`

Run `bun run check` and `bun test` before reporting work complete. Prefer these
commands over ad-hoc ones and keep dependency versions pinned.

## Commits

- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `test:`, `build:`, `ci:`.
- Commit often, in small logical units. Commit after each coherent step rather
  than once at the end of a large task.
- Keep the subject imperative and concise; add a body explaining why when it is
  not obvious.
- Never commit secrets, OCR text, review artifacts, or real document data.

## Safety invariants (do not weaken)

- Never modify document contents, and never delete documents or metadata.
- The LLM never calls Paperless directly.
- The worker creates tags, correspondents, and document types only for entries
  in the human-curated whitelist; never from model output.
- Dry-run performs zero Paperless mutations, including state-tag changes.
- Never remove non-state document tags.
- Do not expose a network port or add a web UI.
- Ask before enabling live Paperless writes; live mode requires explicit
  approval and is guarded in code.

## Secrets and data

- Secrets live only in environment variables (`PAPERLESS_API_TOKEN`,
  `LLM_API_KEY`). Never print, log, or commit them.
- `config.json`, `whitelist.json`, and the data directory are git-ignored;
  never commit local config or whitelist files.
- Never log full OCR text, full prompts, raw upstream responses, or secrets.
- Review artifacts contain derived personal metadata; treat them as personal
  data and keep them out of the repository.

## Engineering conventions

- Bun and TypeScript only; prefer Bun and Web platform APIs over dependencies.
- Add a dependency only when it removes meaningful complexity, and justify it.
- Prefer small functions and plain data over classes and abstraction layers.
- Keep business rules in pure functions and isolate side effects.
- Validate untrusted API and LLM responses at the boundary.
- Tests use `bun test` with mocked `fetch`; they must not require live services
  or credentials.
- Do not add Docker, CI, or deployment infrastructure before milestone M4.

## Workflow

1. Read `PLAN.md` and `TASKS.md`, and work in milestone order.
2. Update `TASKS.md` status markers (`[ ]`, `[~]`, `[x]`, `[-]`) as you go.
3. Stop and ask when a change would alter a safety invariant, when the installed
   API contradicts the plan, or when live writes have not been approved.
