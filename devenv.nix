{ pkgs, ... }:

{
  languages.javascript.enable = true;
  languages.javascript.bun.enable = true;

  # Git and the Docker CLI are development tools only; they are never part of
  # the production image (see Dockerfile and .dockerignore).
  packages = [
    pkgs.git
    pkgs.docker-client
  ];

  # Canonical project tasks. Prefixed to avoid shadowing the shell's `test`.
  scripts = {
    pc-dev.exec = "bun run dev";
    pc-check.exec = "bun run check";
    pc-lint.exec = "bun run lint";
    pc-format.exec = "bun run format";
    pc-typecheck.exec = "bun run typecheck";
    pc-test.exec = "bun test";
    pc-build.exec = "bun run build";
    pc-docker-build.exec = "docker build -t paperless-curator:local .";
  };
}
