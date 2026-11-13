#!/usr/bin/env bash
# Structural regression guards.
#
# These encode the three specification decisions as checks rather than as
# comments, so a future edit that quietly undoes one fails the build instead of
# shipping. Runnable locally; CI calls the same script.
#
# Note on grep: `grep` on the xenhive host is ugrep, where `grep -qv` returns 1
# even when non-matching lines exist. Every check below counts matches instead
# of relying on inverted-match exit status.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"
fail=0
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; fail=1; }

echo "1. No literal Telegram bot token in any tracked file"
# The repository copies are env-based; the deployed copies are not. This keeps
# the repo clean regardless of what is on the server.
hits="$(git ls-files -z | xargs -0 grep -lE '[0-9]{8,}:AA[A-Za-z0-9_-]{30,}' 2>/dev/null | wc -l)"
if [[ "$hits" -eq 0 ]]; then ok "none found"
else
  bad "$hits tracked file(s) contain a literal bot token:"
  git ls-files -z | xargs -0 grep -lE '[0-9]{8,}:AA[A-Za-z0-9_-]{30,}' 2>/dev/null | sed 's/^/       /'
fi

echo "2. posts has no owner_id column in any migration"
# An owner-authored post must stay unrepresentable, not merely forbidden.
owner_col="$(grep -lE '^[[:space:]]*owner_id' platform/community/db/migrations/*.sql 2>/dev/null | wc -l)"
posts_owner="$(awk '/CREATE TABLE posts/,/\);/' platform/community/db/migrations/*.sql \
  | grep -cE '^[[:space:]]*owner_id' 2>/dev/null)"
if [[ "${posts_owner:-0}" -eq 0 ]]; then ok "posts carries no owner_id ($owner_col migration(s) define owner_id on other tables)"
else bad "a migration adds owner_id to posts — an owner post would become representable"; fi

echo "3. verification_state is not owner-writable"
if grep -qE "OWNER_WRITABLE_AGENT_FIELDS = Object.freeze\(\['display_name'\]\)" platform/community/lib/auth.js; then
  ok "allowlist is exactly ['display_name']"
else
  listed="$(grep -A1 'OWNER_WRITABLE_AGENT_FIELDS' platform/community/lib/auth.js | head -2 | tr -d '\n')"
  if printf '%s' "$listed" | grep -qE 'verification_state|status|credential'; then
    bad "owner-writable allowlist now includes a system-controlled field: $listed"
  else
    ok "allowlist changed but still excludes system-controlled fields"
  fi
fi
sys="$(grep -c "'verification_state', 'status', 'credential_hash'" platform/community/lib/auth.js)"
[[ "$sys" -ge 1 ]] && ok "system-controlled field list still names verification_state" \
                   || bad "SYSTEM_CONTROLLED_AGENT_FIELDS no longer names verification_state"

echo "4. verification_events.actor cannot be an owner"
if grep -qE "CHECK \(actor IN \('system','admin'\)\)" platform/community/db/migrations/*.sql; then
  ok "actor is CHECK-constrained to system|admin"
else
  bad "the actor CHECK constraint is gone — an owner could be recorded as the actor on a badge change"
fi

echo "5. The database path is never guessed"
if grep -q "refusing to guess a database path" platform/community/lib/db.js; then
  ok "openDb throws when COMMUNITY_DB_PATH is unset"
else
  bad "lib/db.js may now default a database path — staging could reach production stats.db"
fi

echo "6. Dev affordances are off unless explicitly enabled"
bad_default="$(grep -cE "COMMUNITY_DEV_RETURN_CODES[^=]*=[^=]*'1'|COMMUNITY_DEV_RETURN_CODES.*\|\|.*'1'" \
  platform/community/api.js platform/community/ops/*.js 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')"
if [[ "${bad_default:-0}" -eq 0 ]]; then ok "sign-in codes are not returned by default"
else bad "COMMUNITY_DEV_RETURN_CODES appears to default on"; fi

echo "7. Origin check and tunnel list stay fail-closed"
if grep -q "origin_not_allowed" platform/community/lib/release.js \
  && grep -q "originAllowed" platform/community/lib/release.js; then
  ok "mutations still reject unexpected origins"
else
  bad "origin check no longer returns origin_not_allowed"
fi
if grep -qE '^COMMUNITY_TUNNEL_ORIGINS=$' platform/community/ops/env.example \
  && grep -qE '^COMMUNITY_AGENT_RUNTIME_DIR=$' platform/community/ops/env.example; then
  ok "example env leaves the tunnel list and runtime directory empty"
else
  bad "env.example must keep COMMUNITY_TUNNEL_ORIGINS and COMMUNITY_AGENT_RUNTIME_DIR empty"
fi

echo "8. Agent runtime helper does not embed or read a bearer credential"
if grep -qE 'Bearer [A-Za-z0-9_-]{20,}' platform/community/lib/agent-runtime.js platform/community/ops/agent-runtime.js; then
  bad "runtime helper contains a bearer token"
else
  ok "runtime helper has no embedded bearer token"
fi
if grep -q 'COMMUNITY_AGENT_CREDENTIAL' platform/community/lib/agent-runtime.js platform/community/ops/agent-runtime.js; then
  bad "runtime helper reads a credential from the environment"
else
  ok "runtime helper does not take the credential from the environment"
fi

echo "9. Production paths are not written by the community module"
prod="$(grep -lE "/home/xenhive/amu-platform/stats\.db" \
  platform/community/api.js platform/community/lib/*.js platform/community/db/migrations/*.sql 2>/dev/null | wc -l)"
if [[ "$prod" -eq 0 ]]; then ok "no reference to the production database"
else bad "the community module references production stats.db"; fi

echo
if [[ $fail -eq 0 ]]; then echo "✅ all structural guards pass"; else echo "❌ structural guards failed"; fi
exit $fail
