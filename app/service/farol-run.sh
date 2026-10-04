#!/usr/bin/env bash
# Send the current checkout to a Farol run service and stream the run. Usage:
#   FAROL_URL=… FAROL_KEY=frl_… farol-run.sh <pipeline id or name> [dir]
set -euo pipefail

pipeline="${1:?usage: farol-run.sh <pipeline id or name> [dir]}"
dir="${2:-.}"
url="${FAROL_URL:-http://localhost:8787}"
: "${FAROL_KEY:?set FAROL_KEY to an API key (farol-service keys create) or a session token}"

app_root="$(cd "$(dirname "$0")/.." && pwd)"
abs_dir="$(cd "$dir" && pwd)"
archive="$(mktemp -t farol-snapshot.XXXXXX)"
trap 'rm -f "$archive"' EXIT

node --experimental-strip-types "$app_root/scripts/checkout-snapshot.ts" "$abs_dir" >"$archive"

echo "snapshot: $(du -h "$archive" | cut -f1)" >&2
run_id="$(curl -fsS -X POST "$url/v1/runs" \
  -H "Authorization: Bearer $FAROL_KEY" -H "X-Farol-Pipeline: $pipeline" \
  --data-binary @"$archive" | sed -n 's/.*"runId":"\([0-9a-f]*\)".*/\1/p')"
[ -n "$run_id" ] || { echo "run was not accepted" >&2; exit 1; }
echo "run $run_id" >&2

trap 'curl -fsS -X POST "$url/v1/runs/$run_id/cancel" -H "Authorization: Bearer $FAROL_KEY" >/dev/null || true' INT
curl -fsSN "$url/v1/runs/$run_id/events" -H "Authorization: Bearer $FAROL_KEY"
echo
curl -fsS --compressed "$url/v1/runs/$run_id" -H "Authorization: Bearer $FAROL_KEY"
echo
