#!/usr/bin/env bash
# Repo ↔ deployed drift report.
#
# The inspection found production had silently diverged from the repository:
# /var/www/affiliatemeetups/index.html carries the live join form and the repo
# copy does not, so deploying the repo would have regressed the site. This makes
# that class of surprise visible before a deploy instead of after one.
set -uo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
SITE_DEPLOYED="${SITE_DEPLOYED:-/var/www/affiliatemeetups}"
PLATFORM_DEPLOYED="${PLATFORM_DEPLOYED:-/home/xenhive/amu-platform}"

status=0
printf '%-34s %-10s %s\n' FILE STATE DETAIL
printf '%-34s %-10s %s\n' ---- ----- ------

compare() {
  local label="$1" repo="$2" live="$3"
  if [[ ! -f "$repo" && ! -f "$live" ]]; then
    printf '%-34s %-10s %s\n' "$label" "ABSENT" "neither side"
  elif [[ ! -f "$repo" ]]; then
    printf '%-34s %-10s %s\n' "$label" "LIVE-ONLY" "not in repo — would be lost by a naive deploy"
    status=1
  elif [[ ! -f "$live" ]]; then
    printf '%-34s %-10s %s\n' "$label" "REPO-ONLY" "not deployed"
  elif [[ "$(md5sum "$repo" | cut -d' ' -f1)" == "$(md5sum "$live" | cut -d' ' -f1)" ]]; then
    printf '%-34s %-10s %s\n' "$label" "SAME" "-"
  else
    printf '%-34s %-10s %s\n' "$label" "DRIFT" \
      "repo $(stat -c%s "$repo")B vs live $(stat -c%s "$live")B"
    status=1
  fi
}

compare "site/index.html" "$REPO_ROOT/site/index.html" "$SITE_DEPLOYED/index.html"
for f in api-members.js serve-digest.js onboarding.js tracker.js ingest-webhook.js \
         telegram-relay.js generate-digest.js weekly-digest.js post-highlights.js \
         handle-reaction.js summarize-links.js anthropic-lib.js; do
  compare "platform/$f" "$REPO_ROOT/platform/$f" "$PLATFORM_DEPLOYED/$f"
done

echo
echo "Secrets check (deployed tree) — a literal bot token must never be in a deployed file:"
hits=0
for f in "$PLATFORM_DEPLOYED"/*.js; do
  [[ -f "$f" ]] || continue
  if grep -qE '[0-9]{8,}:AA[A-Za-z0-9_-]{30,}' "$f" 2>/dev/null; then
    printf '  ⚠️  %-28s mode %s  hardcoded token\n' "$(basename "$f")" "$(stat -c%a "$f")"
    hits=$((hits + 1)); status=1
  fi
done
[[ $hits -eq 0 ]] && echo "  ✅ none found"

echo
[[ $status -eq 0 ]] && echo "✅ no drift" || echo "⚠️  drift or exposed secrets present — resolve before deploying"
exit $status
