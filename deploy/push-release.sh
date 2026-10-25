#!/usr/bin/env bash
# =============================================================================
# Sends the committed code (HEAD) to the test server and installs it.
# Used from your Mac and by the GitHub Actions deploy job alike.
#
#   deploy/push-release.sh <server address>      e.g. 139.59.1.2
#
# Only committed files are sent (git archive): never .env, never your
# uncommitted edits. Needs SSH access as the "deploy" user.
# =============================================================================
set -euo pipefail

HOST="${1:?usage: deploy/push-release.sh <server address>}"
cd "$(git rev-parse --show-toplevel)"
SHA="$(git rev-parse HEAD)"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Note: you have uncommitted changes. Only the last commit (${SHA:0:7}) is deployed." >&2
fi

TMP="$(mktemp "${TMPDIR:-/tmp}/claru-release.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP" HEAD
echo "Deploying ${SHA:0:7} ($(du -h "$TMP" | cut -f1)) to $HOST"

REMOTE="/tmp/claru-release-${SHA:0:12}.tgz"
scp -q -o BatchMode=yes "$TMP" "deploy@$HOST:$REMOTE"
ssh -o BatchMode=yes "deploy@$HOST" "sudo /opt/claru/bin/release.sh '$REMOTE' '$SHA'"
