#!/usr/bin/env bash
# Blütenpfad — Backup-Skript
# ----------------------------
# Sichert DB, Uploads und Thumbs als timestamped tar.gz.
# Vorher: WAL-Checkpoint (falls sqlite3 vorhanden), damit das DB-File konsistent ist.
#
# Usage:
#   scripts/backup.sh /pfad/zum/backupziel
#   BP_BACKUP_DIR=/var/backups/bluetenpfad scripts/backup.sh
#
# ENV (Override, sonst Default-Pfade):
#   BP_DATA_DIR   default /var/lib/bluetenpfad/data    (oder ./data falls vorhanden)
#   BP_MEDIA_DIR  default /var/lib/bluetenpfad         (uploads/ + thumbs/)
#   BP_DB_NAME    default wildblumen.db
#   BP_BACKUP_DIR (oder $1)
#
# Retention: behält die letzten 14 timestamped Archive im Zielordner.

set -euo pipefail

DEFAULT_DATA="/var/lib/bluetenpfad/data"
DEFAULT_MEDIA="/var/lib/bluetenpfad"

# Lokales Dev-Fallback, falls /var/lib/bluetenpfad nicht existiert:
if [ ! -d "$DEFAULT_DATA" ] && [ -d "$(dirname "$0")/../data" ]; then
  DEFAULT_DATA="$(cd "$(dirname "$0")/../data" && pwd)"
fi
if [ ! -d "$DEFAULT_MEDIA" ] && [ -d "/mnt/media/wildblumen" ]; then
  DEFAULT_MEDIA="/mnt/media/wildblumen"
fi

DATA_DIR="${BP_DATA_DIR:-$DEFAULT_DATA}"
MEDIA_DIR="${BP_MEDIA_DIR:-$DEFAULT_MEDIA}"
DB_NAME="${BP_DB_NAME:-wildblumen.db}"
BACKUP_DIR="${1:-${BP_BACKUP_DIR:-}}"

if [ -z "$BACKUP_DIR" ]; then
  echo "Fehler: Backup-Zielordner fehlt." >&2
  echo "Usage: scripts/backup.sh /pfad/zum/backupziel  (oder BP_BACKUP_DIR setzen)" >&2
  exit 64
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/bluetenpfad-$TS.tar.gz"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[backup] data=$DATA_DIR  media=$MEDIA_DIR  db=$DB_NAME"

# DB-Snapshot (WAL-checkpoint + .backup wenn sqlite3 da ist, sonst cp).
if [ -f "$DATA_DIR/$DB_NAME" ]; then
  mkdir -p "$WORK/data"
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "[backup] sqlite3 .backup → konsistenter Snapshot"
    sqlite3 "$DATA_DIR/$DB_NAME" "PRAGMA wal_checkpoint(TRUNCATE);"
    sqlite3 "$DATA_DIR/$DB_NAME" ".backup '$WORK/data/$DB_NAME'"
  else
    echo "[backup] sqlite3 fehlt — fallback: cp (DB sollte gestoppt sein)"
    cp -a "$DATA_DIR/$DB_NAME" "$WORK/data/$DB_NAME"
    for sfx in -wal -shm; do
      [ -f "$DATA_DIR/$DB_NAME$sfx" ] && cp -a "$DATA_DIR/$DB_NAME$sfx" "$WORK/data/" || true
    done
  fi
else
  echo "[backup] Hinweis: $DATA_DIR/$DB_NAME nicht gefunden — überspringe DB"
fi

# Medien (rsync nur falls vorhanden).
for sub in uploads thumbs; do
  if [ -d "$MEDIA_DIR/$sub" ]; then
    mkdir -p "$WORK/$sub"
    cp -a "$MEDIA_DIR/$sub/." "$WORK/$sub/" 2>/dev/null || true
  fi
done

# Tarball bauen.
( cd "$WORK" && tar -czf "$TARGET" . )
echo "[backup] geschrieben: $TARGET ($(du -h "$TARGET" | cut -f1))"

# Retention: behalte die letzten 14.
ls -1t "$BACKUP_DIR"/bluetenpfad-*.tar.gz 2>/dev/null | tail -n +15 | while read -r old; do
  echo "[backup] rotate weg: $old"
  rm -f "$old"
done

echo "[backup] fertig."
