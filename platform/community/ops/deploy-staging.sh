#!/usr/bin/env bash
# Repository-controlled staging deployment.
#
# Dry-run by default: it prints exactly what it would do and what a privileged
# operator must run. The inspected deploy path was a manual file copy with no
# manifest and no rollback, which is how production drifted from the repo.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
STAGING_ROOT="${STAGING_ROOT:-/srv/amu-staging}"
DB_PATH="${COMMUNITY_DB_PATH:-$STAGING_ROOT/community-staging.db}"
APPLY="${1:-}"

say() { printf '%s\n' "$*"; }
run() {
  if [[ "$APPLY" == "--apply" ]]; then
    say "+ $*"; "$@"
  else
    say "  would run: $*"
  fi
}

say "AMU staging deploy"
say "  repo        $REPO_ROOT"
say "  commit      $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '(not a git checkout)')"
say "  branch      $(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
say "  staging     $STAGING_ROOT"
say "  database    $DB_PATH"
say "  mode        ${APPLY:---dry-run}"
say ""

# A deploy from a dirty tree cannot be reproduced from a commit.
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
  say "⚠️  working tree is dirty — deploying something that is not in any commit:"
  git -C "$REPO_ROOT" status --short | sed 's/^/     /'
  if [[ "$APPLY" == "--apply" ]]; then
    say "❌ refusing to apply from a dirty tree. Commit first, or export STAGING_ALLOW_DIRTY=1."
    [[ "${STAGING_ALLOW_DIRTY:-}" == "1" ]] || exit 1
  fi
  say ""
fi

if [[ ! -d "$STAGING_ROOT" ]]; then
  say "Staging root does not exist. It is owned by root, so this step is a privileged action:"
  say "    sudo install -d -o \"\$(id -un)\" -g \"\$(id -gn)\" -m 2750 $STAGING_ROOT"
  say ""
fi

say "1. Back up the staging database (no-op on first deploy)"
if [[ -f "$DB_PATH" ]]; then
  run bash "$REPO_ROOT/platform/community/ops/backup-db.sh" "$DB_PATH"
else
  say "  (no database yet — nothing to back up)"
fi

say "2. Apply migrations"
run env COMMUNITY_DB_PATH="$DB_PATH" node "$REPO_ROOT/platform/community/lib/migrate.js" "$DB_PATH"

say "3. Run the test suite against a throwaway database"
run env NODE_PATH="${NODE_PATH:-/home/xenhive/amu-platform/node_modules}" \
    npm --prefix "$REPO_ROOT/platform/community" test

say "4. Start or reload the staging service"
run pm2 startOrReload "$REPO_ROOT/platform/community/ops/ecosystem.staging.config.js"

say ""
say "Privileged steps that remain (not performed by this script):"
say "  a. nginx: include platform/community/ops/nginx-community.conf in the"
say "     affiliatemeetups.com server block, add the two limit_req zones, then"
say "       sudo nginx -t && sudo systemctl reload nginx"
say "  b. set COMMUNITY_ADMIN_TOKEN in the staging environment file (0600)"
say "  c. rotate the Telegram bot token exposed in the deployed platform files"
say "     and move it to the environment — see ops/rotate-bot-token.sh"
[[ "$APPLY" == "--apply" ]] || say ""
[[ "$APPLY" == "--apply" ]] || say "Dry run only. Re-run with --apply to execute steps 1-4."
