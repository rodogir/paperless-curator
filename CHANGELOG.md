# Changelog

All notable changes are documented here. This project uses
[Semantic Versioning](https://semver.org/). Container images are published to
`ghcr.io/rodogir/paperless-curator`.

## [0.2.0] - 2026-09-18

### Changed

- **Breaking:** configuration is now TOML (`config.toml`) instead of JSON
  (`config.json`), loaded with Bun's built-in TOML parser. TOML was chosen so
  the file can carry comments.
- The container entrypoint forwards arguments to the worker, so
  `docker run <image> --help` and `--once` work.

### Added

- On first start the container writes a commented `config.toml` (dry-run
  enabled, placeholder URLs) and an empty `whitelist.json` when they are
  missing, then keeps running. Existing files are never overwritten. Controlled
  by `INIT_DATA`, which is set in the image and off elsewhere.

### Upgrade notes

- Rename `config.json` to `config.toml` and convert it to TOML, or delete it and
  let the container recreate it, then edit the URLs and model. The `CONFIG_PATH`
  default is now `config.toml`; `config.example.toml` shows the format.
- Image: `ghcr.io/rodogir/paperless-curator:0.2.0`.

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
