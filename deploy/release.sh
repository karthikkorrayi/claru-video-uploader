#!/usr/bin/env bash
# =============================================================================
# Installs one release on the server. Runs as root (the deploy user may run
# exactly this script with sudo, nothing else).
#
#   release.sh <tarball> <git sha>
#
# Additive: every release goes into its own folder under /opt/claru/releases.
# The live site switches to it only after install, build and migrations pass,
# and stays on it only if the health check passes; otherwise it switches back
# to the previous release. The last 5 releases are kept.
#
# Data is never touched: recordings live in /var/lib/claru, settings in
# /etc/claru/claru.env. Migrations only add tables and columns, so the previous
# release still runs against a migrated database.
# =============================================================================
set -euo pipefail

TARBALL="${1:?usage: release.sh <tarball> <git sha>}"
SHA="${2:?usage: release.sh <tarball> <git sha>}"
case "$SHA" in *[!0-9a-f]* | "") echo "bad sha: $SHA" >&2; exit 2 ;; esac
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
[ -f "$TARBALL" ] || { echo "no such file: $TARBALL" >&2; exit 1; }

ROOT=/opt/claru
ENV_FILE=/etc/claru/claru.env
ID="$(date -u +%Y%m%d-%H%M%S)-${SHA:0:7}"
DIR="$ROOT/releases/$ID"
SERVICES="claru-mock-claru claru-mock-graph claru-server"

log() { printf '[release %s] %s\n' "$ID" "$1"; }
as_claru() { runuser -u claru -- env HOME=/var/lib/claru npm_config_cache=/var/lib/claru/.npm "$@"; }

exec 9>/run/lock/claru-release.lock
flock -n 9 || { echo "another release is running" >&2; exit 1; }

log "unpacking"
mkdir -p "$DIR"
tar -xzf "$TARBALL" -C "$DIR"
echo "$SHA" > "$DIR/REVISION"
chown -R claru:claru "$DIR"
rm -f "$TARBALL"

cd "$DIR"
log "installing packages"
as_claru npm ci --no-audit --no-fund --loglevel=error
log "building the web app"
as_claru npm run -s build -w @cvu/web
log "applying database migrations"
runuser -u claru -- bash -c "set -a; . '$ENV_FILE'; set +a; cd '$DIR' && HOME=/var/lib/claru node_modules/.bin/tsx server/scripts/migrate.ts"

PREV=""
[ -L "$ROOT/current" ] && PREV="$(readlink -f "$ROOT/current")"
switch_to() { ln -sfn "$1" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"; }
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:8080/api/healthz >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# Service definitions travel with the code: install this release's versions.
install -m 644 "$DIR"/deploy/systemd/claru-*.service /etc/systemd/system/
systemctl daemon-reload

log "switching to the new release (previous: ${PREV:-none})"
switch_to "$DIR"
# shellcheck disable=SC2086
systemctl restart $SERVICES
if healthy; then
  log "healthy — live"
else
  log "health check FAILED — last server log lines:"
  journalctl -u claru-server -n 30 --no-pager -o cat || true
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    log "rolling back to $PREV"
    switch_to "$PREV"
    # shellcheck disable=SC2086
    systemctl restart $SERVICES
    healthy && log "previous release is back" || log "previous release is not healthy either — look at the logs"
  fi
  exit 1
fi

# Keep the 5 newest releases, never the live one.
LIVE="$(readlink -f "$ROOT/current")"
find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | tail -n +6 | while read -r old; do
  [ "$ROOT/releases/$old" = "$LIVE" ] || rm -rf "${ROOT:?}/releases/$old"
done
log "done"
