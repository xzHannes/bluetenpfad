#!/usr/bin/env bash
# Blütenpfad — Migration vom Pi auf den Netcup-VPS
# ------------------------------------------------
# 1. Pi-Service stoppen (sauberer WAL-Checkpoint)
# 2. DB + uploads + thumbs vom Pi nach lokal (Dev-PC) syncen
# 3. Auf VPS: Service stoppen, alte DB sichern, neue Daten reinrsyncen, starten
#
# Voraussetzungen:
#   - SSH-Login auf pi@DEINE.PI.IP funktioniert (LAN)
#   - SSH-Login auf root@DEINE.VPS.IP funktioniert (Key bereits deployed)
#   - Backup-Skript wurde vorher mind. 1× geprobt

set -euo pipefail

PI_SSH="${BP_PI_SSH:-pi@DEINE.PI.IP}"
PI_DIR="${BP_PI_DIR:-/home/pi/wildblumen}"
PI_MEDIA="${BP_PI_MEDIA:-/mnt/media/wildblumen}"

VPS_SSH="${BP_VPS_SSH:-root@DEINE.VPS.IP}"
VPS_DATA="/var/lib/bluetenpfad/data"
VPS_MEDIA="/var/lib/bluetenpfad"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
echo "[migrate] Staging in $STAGE"

echo "[migrate] 1/5 — Pi-Service stoppen + WAL-Checkpoint"
ssh "$PI_SSH" "sudo systemctl stop wildblumen.service || true"
ssh "$PI_SSH" "command -v sqlite3 >/dev/null && sqlite3 '$PI_DIR/data/wildblumen.db' 'PRAGMA wal_checkpoint(TRUNCATE);' || true"

echo "[migrate] 2/5 — DB+Medien vom Pi ziehen"
mkdir -p "$STAGE/data" "$STAGE/uploads" "$STAGE/thumbs"
rsync -avz "$PI_SSH:$PI_DIR/data/" "$STAGE/data/"
rsync -avz "$PI_SSH:$PI_MEDIA/uploads/" "$STAGE/uploads/"
rsync -avz "$PI_SSH:$PI_MEDIA/thumbs/" "$STAGE/thumbs/"

echo "[migrate] 3/5 — VPS-Service stoppen + alte DB sichern"
ssh "$VPS_SSH" "systemctl stop bluetenpfad"
ssh "$VPS_SSH" "if [ -f $VPS_DATA/wildblumen.db ]; then mv $VPS_DATA/wildblumen.db $VPS_DATA/wildblumen.db.pre-migrate.$(date +%s); fi"

echo "[migrate] 4/5 — Daten auf VPS rsyncen"
rsync -avz "$STAGE/data/"     "$VPS_SSH:$VPS_DATA/"
rsync -avz "$STAGE/uploads/"  "$VPS_SSH:$VPS_MEDIA/uploads/"
rsync -avz "$STAGE/thumbs/"   "$VPS_SSH:$VPS_MEDIA/thumbs/"
ssh "$VPS_SSH" "chown -R bluetenpfad:bluetenpfad $VPS_MEDIA"

echo "[migrate] 5/5 — VPS-Service starten + Health-Check"
ssh "$VPS_SSH" "systemctl start bluetenpfad && sleep 2 && curl -fsS http://127.0.0.1:8068/health"
echo

echo "[migrate] Hinweis: Pi-Service nicht automatisch wieder gestartet."
echo "         Wenn du den Pi weiterlaufen lassen willst:"
echo "           ssh $PI_SSH sudo systemctl start wildblumen.service"
echo "[migrate] fertig."
