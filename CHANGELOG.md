# Changelog

All notable changes are documented here. This project uses
[Semantic Versioning](https://semver.org/). Container images are published to
`ghcr.io/rodogir/paperless-curator`.

## [0.1.1] - 2026-09-18

### Changed

- The container now drops privileges to `PUID`/`PGID` (default `99:100`,
  Unraid's `nobody`/`users`) instead of running as the baked-in `bun` user
  (uid 1000). The worker still runs non-root, and an explicit `--user` is
  respected.

### Added

- `PUID`/`PGID` variables to the image entrypoint and the Unraid template.
- `unraid/paperless-curator.xml` template.

### Upgrade notes

- Upgrading from `0.1.0`: set `PUID`/`PGID` to match the owner of your data
  directory (the defaults `99:100` suit Unraid). The entrypoint chowns `/data`
  only when the target user cannot already write it, so a correctly owned
  appdata directory is untouched. If you previously chowned appdata to
  `1000:1000`, either change it back to `99:100` or set `PUID=1000` and
  `PGID=1000`.
- Image: `ghcr.io/rodogir/paperless-curator:0.1.1`.

## [0.1.0] - 2026-09-18

### Added

- First packaged release: continuous Paperless-ngx worker that suggests
  document metadata with an OpenAI-compatible LLM, driven by a human-curated
  whitelist. Dry-run is the default; live writes require `dryRun=false` and the
  `--live` flag. State tags track processing, and unresolved documents produce a
  review artifact with automatic requeue once whitelist gaps are filled.
- Multi-stage Bun image with a pinned base, no exposed ports, and a `/data`
  volume.
- GitHub Actions CI and GHCR release publishing.
