#!/usr/bin/env bash
# =============================================================================
# Creates an admin account on the server (installed as `claru-admin`, run as root).
#
#   claru-admin <username> "<Display name>"
#
# The password is typed twice, hidden, and never stored in plain text or shown
# in the process list. Consultants are added afterwards in the web app (Users).
# =============================================================================
set -euo pipefail
USERNAME="${1:?usage: claru-admin <username> \"<Display name>\"}"
NAME="${2:?usage: claru-admin <username> \"<Display name>\"}"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

read -r -s -p "Password for $USERNAME (12+ characters, hidden): " P1; echo
read -r -s -p "Same password again: " P2; echo
[ "$P1" = "$P2" ] || { echo "The passwords differ. Nothing was created." >&2; exit 1; }

cd /opt/claru/current
printf '%s' "$P1" | runuser -u claru -- bash -c 'set -a; . /etc/claru/claru.env; set +a; HOME=/var/lib/claru node_modules/.bin/tsx server/scripts/create-admin.ts --username "$1" --display-name "$2" --password-stdin' _ "$USERNAME" "$NAME"
P1=""; P2=""
