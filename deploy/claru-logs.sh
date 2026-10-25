#!/usr/bin/env bash
# =============================================================================
# Readable server logs (installed on the server as `claru-logs`).
#
#   claru-logs                 last 200 lines of the app
#   claru-logs -f              follow live (Ctrl+C to stop)
#   claru-logs errors          warnings and errors of the last 24 hours
#   claru-logs ref abc123      everything about one request (the "reference" a tester quotes)
#   claru-logs since "2 hours ago"
#   claru-logs raw ...         the JSON lines as stored, for grep/jq
#
# Logs are kept 14 days or 2 GB, whichever comes first.
# =============================================================================
set -euo pipefail

UNITS=(-u claru-server -u claru-mock-claru -u claru-mock-graph)

# One JSON log line → "10-26 14:03:12 INFO  request {"reqId":…}". Other lines pass through.
fmt() {
  jq -rR --unbuffered '
    (try fromjson catch null) as $j
    | if ($j | type) == "object" and ($j.level | type) == "number" then
        ((($j.time // 0) / 1000 | floor | strflocaltime("%m-%d %H:%M:%S")) + " "
         + ({"10":"TRACE","20":"DEBUG","30":"INFO ","40":"WARN ","50":"ERROR","60":"FATAL"}[$j.level | tostring] // "?    ") + " "
         + ($j.msg // "") + " "
         + ($j | del(.time, .level, .msg, .pid, .hostname, .service) | tojson))
      else . end'
}

case "${1:-}" in
  -f) journalctl "${UNITS[@]}" -n 50 -f -o cat | fmt ;;
  errors) journalctl "${UNITS[@]}" --since "24 hours ago" -o cat | fmt | grep -E ' (WARN |ERROR|FATAL) ' || echo "No warnings or errors in the last 24 hours." ;;
  ref)
    REF="${2:?usage: claru-logs ref <reference>}"
    journalctl "${UNITS[@]}" --since "14 days ago" -o cat | grep -F "\"$REF\"" | fmt || echo "Nothing found for reference $REF."
    ;;
  since) journalctl "${UNITS[@]}" --since "${2:?usage: claru-logs since \"2 hours ago\"}" -o cat | fmt ;;
  raw) shift; journalctl "${UNITS[@]}" -o cat "$@" ;;
  "") journalctl "${UNITS[@]}" -n 200 -o cat | fmt ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
