# Contributing

Read [`AGENTS.md`](AGENTS.md) and [`PLAN.md`](PLAN.md) first. `PLAN.md` is the
source of truth for design and safety invariants; do not weaken them.

## Canonical commands

Run these from the repository root. The project pins Bun and all dependency
versions.

| Command | Purpose |
| --- | --- |
| `bun run dev` | Run the worker (`bun run start` is an alias) |
| `bun run check` | Biome check (format, lint, import order) plus `tsc --noEmit` |
| `bun run format` | Write formatting with Biome |
| `bun run lint` | Lint with Biome |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Bun test runner (mocked `fetch`, no live services) |
| `bun run build` | Bundle `src/index.ts` to `dist/` |
| `docker build -t paperless-curator:local .` | Build the runtime image |

Run `bun run check` and `bun test` before reporting work complete. Run
`bun run build` when the bundle or packaging changes.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` a user-visible feature
- `fix:` a bug fix
- `docs:` documentation only
- `test:` tests only
- `refactor:` behavior-preserving code change
- `build:` build system or packaging
- `ci:` continuous integration
- `chore:` other maintenance

Keep the subject imperative and concise; add a body explaining *why* when it is
not obvious. Commit often, in small logical units.

Never commit secrets (`PAPERLESS_API_TOKEN`, `LLM_API_KEY`), OCR text, review
artifacts, local `config.json` / `whitelist.json`, or the `data/` directory.
The `Dockerfile` and `.dockerignore` must never bake those in either.

## Tests

- Use `bun test`. Tests must not require live services or credentials.
- Mock `fetch`; keep fixtures small, sanitized, and free of personal data.
- Add focused tests for behavior that protects unsafe writes.

## Pull requests

1. Work in milestone order and update the status markers in `TASKS.md`.
2. Run `bun run check`, `bun test`, and (when packaging changes) `bun run build`.
3. Keep CI green: the same commands run in GitHub Actions.
4. Stop and ask before any change that would weaken a safety invariant or
   enable live writes.

## Using devenv (optional)

`devenv.nix` provides Bun, Git, and the Docker CLI plus `pc-*` helper scripts
(`pc-check`, `pc-test`, `pc-build`, `pc-docker-build`, and so on). It is a
development convenience only and does not affect the production image.
