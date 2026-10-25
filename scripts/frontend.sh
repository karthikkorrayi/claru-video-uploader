#!/usr/bin/env bash
# Run from any directory. Uses the cloud Node 22 install when available.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x /workspace/.cloud-setup/node22/node_modules/.bin/node ]]; then
  export PATH="/workspace/.cloud-setup/node22/node_modules/.bin:$PATH"
fi
cd "$repo_dir"
case "${1:-check}" in
  check)
    npm run check
    npm run build -w @cvu/web
    git diff --check
    ;;
  dev) npm run dev ;;
  build) npm run build -w @cvu/web ;;
  *) printf 'Usage: %s [check|dev|build]\n' "$0" >&2; exit 2 ;;
esac
