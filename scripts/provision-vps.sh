#!/usr/bin/env bash
# Blütenpfad — VPS-Provisionierung (Debian 13)
# --------------------------------------------
# Installiert Node LTS, Caddy, sqlite3, ufw, fail2ban,
# legt Verzeichnisse + Service-User an, härtet UFW.
#
# Wird per ssh root@... bash -s < scripts/provision-vps.sh ausgeführt.
# Idempotent — kann mehrfach laufen.

set -euo pipefail

echo "[*] apt update + Basics"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg debian-keyring debian-archive-keyring \
  apt-transport-https sqlite3 ufw fail2ban rsync git build-essential python3

# ── Node.js LTS (NodeSource 22.x) ────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[*] NodeSource 22.x"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  echo "[ok] node: $(node -v)"
fi

# ── Caddy (offizielles APT-Repo) ─────────────────────────────────────
if ! command -v caddy >/dev/null 2>&1; then
  echo "[*] Caddy offizielles Repo"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
else
  echo "[ok] caddy: $(caddy version | head -1)"
fi

# ── Service-User ─────────────────────────────────────────────────────
if ! id bluetenpfad >/dev/null 2>&1; then
  echo "[*] User bluetenpfad anlegen"
  useradd --system --create-home --home-dir /var/lib/bluetenpfad \
    --shell /usr/sbin/nologin bluetenpfad
fi

# ── Verzeichnisstruktur ──────────────────────────────────────────────
echo "[*] Verzeichnisse anlegen"
install -d -m 0755 -o root        -g root        /opt/bluetenpfad
install -d -m 0755 -o root        -g root        /opt/bluetenpfad/app
install -d -m 0750 -o bluetenpfad -g bluetenpfad /var/lib/bluetenpfad
install -d -m 0750 -o bluetenpfad -g bluetenpfad /var/lib/bluetenpfad/data
install -d -m 0750 -o bluetenpfad -g bluetenpfad /var/lib/bluetenpfad/uploads
install -d -m 0750 -o bluetenpfad -g bluetenpfad /var/lib/bluetenpfad/thumbs
install -d -m 0750 -o bluetenpfad -g bluetenpfad /var/lib/bluetenpfad/backups

# ── UFW ──────────────────────────────────────────────────────────────
echo "[*] UFW konfigurieren"
ufw --force default deny incoming
ufw --force default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
yes | ufw --force enable
ufw status verbose | head -20

# ── fail2ban (SSH-Brute-Force-Schutz, Default-Profile) ───────────────
systemctl enable --now fail2ban || true

echo "[done] Provisioning abgeschlossen."
node -v; npm -v; caddy version | head -1; sqlite3 --version | awk '{print $1}'
