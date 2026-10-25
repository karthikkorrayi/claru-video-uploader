#!/usr/bin/env bash
# =============================================================================
# One-time setup of a fresh Ubuntu 24.04 Droplet as the Claru Video Uploader
# TEST server. Run as root, once; safe to run again (it only fills in what is
# missing and never overwrites /etc/claru/claru.env or any data).
#
#   bash bootstrap.sh            (from the folder holding the deploy/ files)
#
# Installs: Node 22, PostgreSQL 16, Caddy (HTTPS), ffmpeg, jq.
# Creates:  user "claru" (runs the app, no login), user "deploy" (SSH for
#           deploys; may only run release.sh with sudo), the database, the
#           settings file with fresh secrets, services, log retention, a
#           local firewall, and a 2 GB swap file.
# Talks to: the MOCK Claru and MOCK Graph only (ALLOW_REAL_CLARU=no).
# Costs:    nothing beyond the Droplet itself.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
step() { printf '\n== %s ==\n' "$1"; }
ok() { printf '   ✓ %s\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = "24.04" ] || { echo "Made for Ubuntu 24.04 (this is ${PRETTY_NAME:-unknown})." >&2; exit 1; }
for f in release.sh claru-logs.sh claru-admin.sh Caddyfile.template journald-claru.conf systemd/claru-server.service; do
  [ -f "$HERE/$f" ] || { echo "Missing $HERE/$f — copy the whole deploy/ folder." >&2; exit 1; }
done
export DEBIAN_FRONTEND=noninteractive

step "1/9  Public address and HTTPS name"
IP="$(curl -fsS --max-time 5 http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address || true)"
[ -n "$IP" ] || IP="$(curl -fsS --max-time 5 https://api.ipify.org)"
SITE_HOST="${SITE_HOST:-${IP//./-}.sslip.io}"
ok "public IP $IP → https://$SITE_HOST"

step "2/9  System packages (a few minutes)"
timedatectl set-timezone Asia/Kolkata
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl gnupg jq git ffmpeg postgresql ufw unattended-upgrades \
  debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || ! node --version | grep -q '^v22\.'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get -y -q install nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get -y -q install caddy
fi
ok "node $(node --version), $(psql --version | awk '{print "postgres " $3}'), caddy $(caddy version | awk '{print $1}'), ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

step "3/9  Swap (2 GB, so installs and builds never run out of memory)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
ok "swap on"

step "4/9  Users and folders"
id claru >/dev/null 2>&1 || useradd --system --home-dir /var/lib/claru --shell /usr/sbin/nologin claru
if ! id deploy >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash deploy
fi
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# Your own key (the one the Droplet was created with) may deploy from your Mac.
if [ -f /root/.ssh/authorized_keys ]; then
  touch /home/deploy/.ssh/authorized_keys
  while read -r key; do
    [ -n "$key" ] && ! grep -qxF "$key" /home/deploy/.ssh/authorized_keys && echo "$key" >> /home/deploy/.ssh/authorized_keys
  done < /root/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 600 /home/deploy/.ssh/authorized_keys
fi
install -d -m 755 /opt/claru /opt/claru/releases /opt/claru/bin
install -d -m 750 -o claru -g claru /var/lib/claru /var/lib/claru/work /var/lib/claru/tus /var/lib/claru/.npm
install -d -m 750 -o root -g claru /etc/claru
install -m 755 "$HERE/release.sh" /opt/claru/bin/release.sh
install -m 755 "$HERE/claru-logs.sh" /usr/local/bin/claru-logs
install -m 755 "$HERE/claru-admin.sh" /usr/local/bin/claru-admin
cat > /etc/sudoers.d/claru-deploy <<'EOF'
# The deploy user may install releases, and nothing else.
deploy ALL=(root) NOPASSWD: /opt/claru/bin/release.sh
EOF
chmod 440 /etc/sudoers.d/claru-deploy
visudo -cf /etc/sudoers.d/claru-deploy >/dev/null
ok "users claru and deploy, /opt/claru, /var/lib/claru, claru-logs, claru-admin"

step "5/9  Database"
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'claru'" | grep -q 1 || runuser -u postgres -- createuser claru
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'claru'" | grep -q 1 || runuser -u postgres -- createdb -O claru claru
ok "database claru, owned by OS user claru (local socket, no password)"

step "6/9  Settings (/etc/claru/claru.env)"
ENV_FILE=/etc/claru/claru.env
if [ ! -f "$ENV_FILE" ]; then
  umask 027
  cat > "$ENV_FILE" <<EOF
# Test server settings. Secrets were generated on this server and exist only here.
# Edit with: sudo nano $ENV_FILE   then: sudo systemctl restart claru-server
NODE_ENV=production
ENVIRONMENT_LABEL="Test server — mock Claru, not for real deliveries"
HOST=127.0.0.1
PORT=8080
LOG_LEVEL=info
TRUST_PROXY=loopback
COOKIE_SECURE=yes
SESSION_HOURS=12
DATABASE_URL=postgresql://claru@localhost/claru?host=/var/run/postgresql
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
TOKEN_ENC_KEY=$(openssl rand -base64 32 | tr -d '\n')
WORK_DIR=/var/lib/claru/work
TUS_DIR=/var/lib/claru/tus
MAX_UPLOAD_GB=8
DISK_RESERVE_GB=10
UPLOAD_ABANDON_HOURS=72
# Claru: the MOCK on this server. Real Claru would need ALLOW_REAL_CLARU=yes (not on a test server).
MOCK_CLARU_PORT=4010
MOCK_CLARU_KEY=$(openssl rand -hex 24)
CLARU_BASE_URL=http://127.0.0.1:4010/api/v1
ALLOW_REAL_CLARU=no
CLARU_CONTRACT_VERSION=2
CLARU_PROJECT_ID=92070f8b-acfb-44c2-8e73-1e6d9918a2b6
CLIP_MIN_SECONDS=300
CLIP_MAX_SECONDS=1800
CAPTURE_ASPECT=4_3
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
MOCK_GRAPH_PORT=4020
GRAPH_BASE_URL=http://127.0.0.1:4020/v1.0
EOF
  # The app reads the mock key under the name it uses for real Claru.
  echo "CLARU_API_KEY=$(sed -n 's/^MOCK_CLARU_KEY=//p' "$ENV_FILE")" >> "$ENV_FILE"
  chown root:claru "$ENV_FILE" && chmod 640 "$ENV_FILE"
  ok "created with fresh secrets (readable by root and the app only)"
else
  ok "already there — left unchanged"
fi

step "7/9  Services, logs, HTTPS"
install -m 644 "$HERE"/systemd/claru-*.service /etc/systemd/system/
install -d /etc/systemd/journald.conf.d
install -m 644 "$HERE/journald-claru.conf" /etc/systemd/journald.conf.d/claru.conf
systemctl restart systemd-journald
systemctl daemon-reload
systemctl enable claru-mock-claru claru-mock-graph claru-server >/dev/null 2>&1
install -d -m 755 -o caddy -g caddy /var/log/caddy
sed "s/__HOST__/$SITE_HOST/" "$HERE/Caddyfile.template" > /etc/caddy/Caddyfile
chmod 644 /etc/caddy/Caddyfile
# Repair a log file left root-owned by an earlier run, then validate AS the caddy user:
# validating opens the log file, and doing it as root leaves a file Caddy cannot write
# (Caddy then refuses the whole config).
chown -R caddy:caddy /var/log/caddy
runuser -u caddy -- env HOME=/var/lib/caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
sleep 2
systemctl is-active --quiet caddy || { journalctl -u caddy -n 20 --no-pager; echo "Caddy did not start (see above)." >&2; exit 1; }
ok "services enabled (they start with the first release); logs kept 14 days / 2 GB; Caddy serving $SITE_HOST"

step "8/9  SSH and local firewall"
cat > /etc/ssh/sshd_config.d/10-claru.conf <<'EOF'
# Keys only. No passwords over SSH.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -t && systemctl reload ssh
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "SSH: keys only; local firewall: 22, 80, 443 (the DigitalOcean Cloud Firewall narrows SSH to your IP)"

step "9/9  Done"
echo "   Site (after the first release): https://$SITE_HOST"
echo "   Next, from your Mac, in the project folder:"
echo "     deploy/push-release.sh $IP"
echo "   Then on the server: sudo claru-admin kk \"Karthik\""
