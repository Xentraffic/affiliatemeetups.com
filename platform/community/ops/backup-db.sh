#!/usr/bin/env bash
# Online, verified SQLite backup.
#
# No backup tooling existed before this branch, which is the reason the
# withdrawal decision had to avoid destructive outcomes. This uses sqlite3
# `.backup` rather than cp, because cp of a live WAL database can capture a
# torn page set; .backup takes a consistent snapshot while writers continue.
set -euo pipefail

# A backup must be as protected as the database it copies. It was not.
#
# Measured on 2026-11-12, on this repository: a 0600 database produced a **644**
# backup inside a **775** directory. Two causes stack up, and either one alone
# would hide the other:
#   1. api.js sets process.umask(0o077), which protects files created by the
#      APPLICATION. A backup script run from cron does not inherit that umask.
#   2. `sqlite3 .backup` creates its file 0644 REGARDLESS of the umask. So a
#      `umask` line alone fixes nothing here.
# The explicit chmods below are therefore the actual fix, not decoration.
umask 077

DB="${1:-${COMMUNITY_DB_PATH:-}}"
OUT_DIR="${2:-$(dirname "${DB:-.}")/backups}"
RETAIN="${BACKUP_RETAIN:-14}"

if [[ -z "$DB" ]]; then echo "usage: $0 <db-path> [out-dir]" >&2; exit 2; fi
if [[ ! -f "$DB" ]]; then echo "❌ no such database: $DB" >&2; exit 1; fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$(basename "$DB")"
DEST="$OUT_DIR/${BASE}.${STAMP}"

sqlite3 "$DB" ".backup '$DEST'"

# A backup that is not verified is a guess.
INTEGRITY="$(sqlite3 "$DEST" 'PRAGMA integrity_check;')"
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "❌ integrity check failed on $DEST: $INTEGRITY" >&2
  rm -f "$DEST"
  exit 1
fi

chmod 600 "$DEST"
sha256sum "$DEST" | awk '{print $1}' > "$DEST.sha256"
chmod 600 "$DEST.sha256"
SRC_TABLES="$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")"
DST_TABLES="$(sqlite3 "$DEST" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")"
if [[ "$SRC_TABLES" != "$DST_TABLES" ]]; then
  echo "❌ table count mismatch: source $SRC_TABLES, backup $DST_TABLES" >&2
  exit 1
fi

echo "✅ $DEST"
echo "   integrity=ok tables=$DST_TABLES sha256=$(cat "$DEST.sha256")"

# Retention: keep the newest $RETAIN, by name (timestamps sort lexically).
mapfile -t OLD < <(ls -1 "$OUT_DIR/${BASE}."*[0-9]Z 2>/dev/null | sort -r | tail -n +$((RETAIN + 1)) || true)
for f in "${OLD[@]:-}"; do
  [[ -n "$f" ]] || continue
  rm -f "$f" "$f.sha256"
  echo "   pruned $(basename "$f")"
done
