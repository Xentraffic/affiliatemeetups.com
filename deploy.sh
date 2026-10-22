#!/usr/bin/env bash
# Deploys site/ to the live web root on xenhive-main.
# Run from a clean checkout of main:  ./deploy.sh
# Refuses to run if the live files were edited since the last deploy,
# so hand edits on the server are never silently overwritten (FORCE=1 overrides).
set -euo pipefail

LIVE=${LIVE:-/var/www/affiliatemeetups}
SUDO=${SUDO-sudo}
OWNER=${OWNER:-xenhive:xenhive}
IMPORT_COMMIT=f6c78bb   # live site as imported into git, used before the first deploy
EXCL=(--exclude='*.bak*' --exclude='*.backup*' --exclude='.deployed-commit')

cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain site)" ]; then
  echo "site/ has uncommitted changes. Commit them first." >&2; exit 1
fi
COMMIT=$(git rev-parse --short HEAD)

LAST=$($SUDO cat "$LIVE/.deployed-commit" 2>/dev/null || echo "$IMPORT_COMMIT")
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
git archive "$LAST" site | tar -x -C "$TMP"
DRIFT=$($SUDO rsync -rcn --out-format='%n' "${EXCL[@]}" "$LIVE/" "$TMP/site/" | grep -v '/$' || true)
if [ -n "$DRIFT" ]; then
  echo "These live files were edited on the server since $LAST:"
  echo "$DRIFT" | sed 's/^/  /'
  echo "Copy them into site/ and commit, or rerun with FORCE=1 to overwrite them."
  [ "${FORCE:-}" = 1 ] || exit 1
fi

echo "Changes to deploy ($LAST -> $COMMIT):"
$SUDO rsync -rcn --out-format='  %n' "${EXCL[@]}" site/ "$LIVE/" | grep -v '/$' || echo "  (none)"
read -rp "Deploy? [y/N] " answer
[ "$answer" = y ] || { echo "Cancelled."; exit 1; }

$SUDO rsync -rc --chown="$OWNER" --chmod=F664,D775 "${EXCL[@]}" site/ "$LIVE/"
echo "$COMMIT" | $SUDO tee "$LIVE/.deployed-commit" >/dev/null
echo "Deployed $COMMIT to $LIVE"
