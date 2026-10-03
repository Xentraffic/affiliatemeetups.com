#!/usr/bin/env bash
# Installs the CLI-based agent tools used in this repo (run once per machine).
#   rtk      - Rust Token Killer: compresses Bash output before it reaches Claude
#   graphify - builds a queryable knowledge graph of the repo (/graphify .)
# ponytail and ui-ux-pro-max are Claude Code plugins, enabled via .claude/settings.json.
# If the rtk installer hits a GitHub API rate limit, pin a version: RTK_VERSION=v0.50.0 ./scripts/setup-agent-tools.sh
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

if ! command -v rtk >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
fi
rtk init -g

if ! command -v graphify >/dev/null; then
  if command -v uv >/dev/null; then uv tool install graphifyy; else pipx install graphifyy; fi
fi
graphify install --project
