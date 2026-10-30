#!/usr/bin/env bash
# Verified restore. Refuses to clobber anything without an explicit --force,
# and always sidelines the current database first.
set -euo pipefail

BACKUP="${1:-}"
TARGET="${2:-${COMMUNITY_DB_PATH:-}}"
FORCE="${3:-}"

if [[ -z "$BACKUP" || -z "$TARGET" ]]; then
  echo "usage: $0 <backup-file> <target-db> [--force]" >&2; exit 2
fi
if [[ ! -f "$BACKUP" ]]; then echo "❌ no such backup: $BACKUP" >&2; exit 1; fi

if [[ -f "$BACKUP.sha256" ]]; then
  WANT="$(cat "$BACKUP.sha256")"
  GOT="$(sha256sum "$BACKUP" | awk '{print $1}')"
  if [[ "$WANT" != "$GOT" ]]; then
    echo "❌ checksum mismatch — refusing to restore" >&2
    echo "   recorded $WANT" >&2; echo "   actual   $GOT" >&2
    exit 1
  fi
  echo "   checksum verified"
else
  echo "⚠️  no .sha256 beside the backup; integrity will be checked but provenance is unverified"
fi

INTEGRITY="$(sqlite3 "$BACKUP" 'PRAGMA integrity_check;')"
[[ "$INTEGRITY" == "ok" ]] || { echo "❌ backup fails integrity check: $INTEGRITY" >&2; exit 1; }

if [[ -f "$TARGET" && "$FORCE" != "--force" ]]; then
  echo "❌ $TARGET exists. Re-run with --force to replace it." >&2
  echo "   The current file would be preserved as $TARGET.replaced-<stamp>." >&2
  exit 1
fi

if [[ -f "$TARGET" ]]; then
  SIDELINE="$TARGET.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
  sqlite3 "$TARGET" ".backup '$SIDELINE'" && echo "   current database preserved at $SIDELINE"
fi

cp "$BACKUP" "$TARGET"
rm -f "$TARGET-wal" "$TARGET-shm"
echo "✅ restored $BACKUP → $TARGET"
sqlite3 "$TARGET" "SELECT 'tables=' || COUNT(*) FROM sqlite_master WHERE type='table';"
