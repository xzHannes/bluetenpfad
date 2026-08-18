#!/usr/bin/env bash
# Blütenpfad — Deploy nach Netcup-VPS
# -----------------------------------
# rsynct App-Code nach /opt/bluetenpfad/app, npm install --omit=dev,
# Caddy + systemd reloaden, Health-Check.
#
# Usage:
#   scripts/deploy-netcup.sh                # nur Code
#   scripts/deploy-netcup.sh --restart-svc  # Code + bluetenpfad.service restart
#
# Erwartet:
#   - SSH-Key-Login als root@DEINE.VPS.IP funktioniert
#   - VPS bereits via scripts/provision-vps.sh provisioniert

set -euo pipefail

SERVER="${BP_SERVER:-root@DEINE.VPS.IP}"
APP_DIR="${BP_APP_DIR:-/opt/bluetenpfad/app}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_DIR"

echo "[deploy] rsync → $SERVER:$APP_DIR"
rsync -avz --delete \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='data' \
  --exclude='certs' \
  --exclude='.env' \
  --exclude='*.local' \
  --exclude='/tmp' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --include='public/vendor/***' \
  ./ "$SERVER:$APP_DIR/"

echo "[deploy] npm install (production) auf dem Server"
ssh "$SERVER" "set -e; cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tail -5"

echo "[deploy] Ownership setzen"
ssh "$SERVER" "chown -R bluetenpfad:bluetenpfad '$APP_DIR'"

if [ "${1:-}" = "--restart-svc" ] || [ "${1:-}" = "-r" ]; then
  echo "[deploy] systemctl restart bluetenpfad + reload caddy"
  ssh "$SERVER" "systemctl daemon-reload && systemctl enable --now bluetenpfad && systemctl restart bluetenpfad && systemctl reload caddy || systemctl restart caddy"
fi

echo "[deploy] Health-Check vom Server (intern)"
sleep 2
ssh "$SERVER" "curl -fsS http://127.0.0.1:8068/health" && echo
echo "[deploy] HTTPS-Check (von außen, falls Cert da ist)"
curl -fsS --max-time 10 https://bluetenpfad.de/health 2>&1 || echo "(noch nicht öffentlich erreichbar — DNS oder Cert in Provisionierung)"

echo "[deploy] fertig."
