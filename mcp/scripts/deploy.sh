#!/usr/bin/env bash
# Deploy tape-mcp (https://tape-mcp.ivar.workers.dev, and https://tape.ivar.workers.dev/mcp through the tape Worker's
# service binding) through a 0% version and a pinned smoke.
#   CLOUDFLARE_ACCOUNT_ID=<id> mcp/scripts/deploy.sh "<message>"
# As service/scripts/deploy.sh: a clean commit on main (or ALLOW_BRANCH=1) that passed the full gate
# (service/scripts/gate.sh), cf with the OAuth login (CLOUDFLARE_API_TOKEN unset), the same lock, the same deploy log.
#
#  1. preflight: a clean tree, the gate's record for this commit, nothing else deploying, cf logged in
#  2. PREV: the version serving 100% (not split); it is what a rollback restores
#  3. build and upload NEW (cf workers versions create): in no deployment yet; NEW must have the IP_SALT secret
#     (a secret carries over to each new version) and the VERSION binding
#  4. route PREV 100% / NEW 0%
#  5. pinned smoke (service/scripts/mcp-smoke.ts --pin tape-mcp=NEW --mcp-version NEW): every answer from NEW; its
#     feedback report is stored under smoke/ (delete them with node mcp/scripts/feedback.ts --delete-smoke)
#  6. telemetry gate on NEW (service/scripts/telemetry.ts --service tape-mcp): no invocation not ok, no 5xx, no error logs
#  7. NEW 100%: wait until unpinned calls answer from NEW, then the smoke unpinned, here and through the tape Worker
#     (/mcp on $TAPE_BASE), and the telemetry gate over the run
# tape-mcp is stateless (no Durable Objects, no storage), so there is no stepped ramp: a version either answers the
# smoke or it does not, and the smoke is the traffic. A failure in 4-7 routes 100% back to PREV, but only while the
# deployment is still the one this run last wrote. Each run appends to $DEPLOY_LOG.
# Rollback by hand (to the PREV a run recorded):
#   env -u CLOUDFLARE_API_TOKEN npx cf workers deployments create --worker tape-mcp \
#     --body '{"strategy":"percentage","versions":[{"version_id":"<PREV>","percentage":100}]}'
set -euo pipefail
MSG=${1:?usage: CLOUDFLARE_ACCOUNT_ID=<id> mcp/scripts/deploy.sh "<message>"}
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SCRIPTS=$ROOT/service/scripts
BASE=${BASE:-https://tape-mcp.ivar.workers.dev}
TAPE_BASE=${TAPE_BASE:-https://tape.ivar.workers.dev}
WORKER=tape-mcp
STATE=${TAPE_STATE:-$HOME/.local/state/tape}
DEPLOY_LOG=${DEPLOY_LOG:-$HOME/code/lab_notebook/tape-2026-11-21/deploys.md}
export WRANGLER_DOCKER_BIN=${WRANGLER_DOCKER_BIN:-/usr/bin/false}
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (the account the OAuth login reaches); it is never written to the repo}"
export CLOUDFLARE_ACCOUNT_ID
cd "$HERE"
cf() { env -u CLOUDFLARE_API_TOKEN npx cf "$@"; }
say() { echo "== $*"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
RUN_START_MS=$(now_ms)
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$STATE/runs"
RUN_LOG="$STATE/runs/$(date -u +%Y%m%dT%H%M%SZ)-mcp.log"
exec > >(tee -a "$RUN_LOG") 2>&1

# ---- 1. preflight
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "the tree is not clean" >&2; exit 1; }
FULL=$(git -C "$ROOT" rev-parse HEAD)
SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD)
BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] || [ "${ALLOW_BRANCH:-}" = 1 ] || { echo "not on main ($BRANCH): ALLOW_BRANCH=1 to deploy it" >&2; exit 1; }
[ -f "$STATE/gate/$FULL" ] || { echo "no gate record for $SHA: run service/scripts/gate.sh first" >&2; exit 1; }
grep -qE " passed, 0 failed," "$STATE/gate/$FULL" || { cat "$STATE/gate/$FULL"; echo "the gate record for $SHA is not a pass" >&2; exit 1; }
LOCK="$STATE/deploy.lock"
mkdir "$LOCK" 2>/dev/null || { echo "another deploy holds $LOCK ($(cat "$LOCK/who" 2>/dev/null))" >&2; exit 1; }
echo "$$ $WORKER $SHA $STAMP" > "$LOCK/who"
trap 'rm -rf "$LOCK"' EXIT INT TERM
say "deploy $WORKER $SHA ($BRANCH) \"$MSG\"; gate: $(sed -n 's/^at //p' "$STATE/gate/$FULL"); run log $RUN_LOG"

json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
latest() { cf workers deployments list --worker "$WORKER" --per-page 1; }
split_of() { latest | json 'print(" ".join("%s:%g" % (v["version_id"], v["percentage"]) for v in d["deployments"][0]["versions"]))'; }
WROTE=""
norm() { printf '%s\n' $1 | sort | tr '\n' ' '; }
route() {
  body=$(python3 -c 'import json,sys; print(json.dumps({"strategy":"percentage","versions":[{"version_id":a.split(":")[0],"percentage":int(a.split(":")[1])} for a in sys.argv[2:]],"annotations":{"workers/message":sys.argv[1][:100]}}))' "$MSG [git $SHA]" "$@")
  cf workers deployments create --worker "$WORKER" --body "$body" > /dev/null
  WROTE="$*"
}
OUTCOME=failed
NOTES=""
record() {
  mkdir -p "$(dirname "$DEPLOY_LOG")"
  {
    printf '\n## %s %s (%s)\n\n' "$STAMP" "$OUTCOME" "$WORKER"
    printf -- '- worker: %s\n- message: %s\n- commit: %s (%s)\n- NEW: %s\n- PREV: %s\n- run log: %s\n' "$WORKER" "$MSG" "$SHA" "$BRANCH" "${NEW:-none}" "${PREV:-none}" "$RUN_LOG"
    if [ -n "$NOTES" ]; then printf '%s' "$NOTES"; fi
  } >> "$DEPLOY_LOG"
}
note() { NOTES="$NOTES- $*
"; say "$*"; }
back() {
  note "FAILED: $1"
  now=$(split_of || echo unknown)
  if [ "$(norm "$now")" = "$(norm "$WROTE")" ]; then
    route "$PREV:100"
    note "rolled back: $PREV 100% (the deployment was still $now, as this run left it)"
    OUTCOME="rolled back"
  else
    note "NOT rolled back: the deployment is $now, not the $WROTE this run wrote; someone else changed it"
    OUTCOME="failed, not rolled back"
  fi
  record
  exit 1
}

# ---- 2. PREV
SPLIT=$(split_of)
case "$SPLIT" in
  *" "*|"") echo "the current deployment is split ($SPLIT): finish or roll it back first" >&2; exit 1 ;;
esac
PREV=${SPLIT%%:*}
[ "${SPLIT#*:}" = 100 ] || { echo "the current deployment is $SPLIT, not one version at 100%" >&2; exit 1; }
say "previous (rollback): $PREV"

# ---- 3. build and upload
say "build"
npx cf build > "$STATE/build-mcp.log" 2>&1 || { tail -30 "$STATE/build-mcp.log"; record; exit 1; }
say "upload"
out=$(cf workers versions create --prebuilt --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" 2>&1) || { echo "$out"; record; exit 1; }
NEW=$(printf '%s\n' "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
[ -n "$NEW" ] || { echo "$out"; echo "no version id in the upload's output" >&2; record; exit 1; }
say "new: $NEW"
cf workers versions get "$NEW" --worker "$WORKER" | json 'import sys; b={x["name"]: x["type"] for x in d["bindings"]}; sys.exit(0 if b.get("IP_SALT")=="secret_text" and b.get("VERSION")=="version_metadata" else 1)' ||
  { note "NEW has no IP_SALT secret or no VERSION binding"; record; exit 1; }

# ---- 4. 0%
route "$PREV:100" "$NEW:0"
say "routed $NEW 0% beside $PREV 100%"
T0=$(now_ms)

# ---- 5. pinned smoke
say "pinned smoke"
smoke() { node "$SCRIPTS/mcp-smoke.ts" "$@"; }
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  v=$(curl -s -o /dev/null -D - -H "cloudflare-workers-version-overrides: $WORKER=\"$NEW\"" "$BASE/v1" | awk 'tolower($1)=="tape-mcp-version:"{gsub("\r","",$2); print $2}')
  [ "$v" = "$NEW" ] && { ok=1; break; }
  sleep 3
done
[ $ok = 1 ] || back "pinned requests never reached $NEW"
smoke "$BASE/mcp" --pin "$WORKER=$NEW" --mcp-version "$NEW" > "$STATE/smoke-mcp.out" 2>&1 || { cat "$STATE/smoke-mcp.out"; back "pinned smoke"; }
cat "$STATE/smoke-mcp.out"
note "pinned smoke: $(tail -1 "$STATE/smoke-mcp.out")"

# ---- 6. telemetry on NEW
say "telemetry gate (0%)"
node "$SCRIPTS/telemetry.ts" "$NEW" "$T0" --min 6 --service "$WORKER" > "$STATE/telemetry-mcp.out" 2>&1 || { cat "$STATE/telemetry-mcp.out"; back "telemetry at 0%"; }
cat "$STATE/telemetry-mcp.out"
note "0%: $(grep '^telemetry ' "$STATE/telemetry-mcp.out")"

# ---- 7. 100%
route "$NEW:100"
say "routed $NEW 100%"
n=0
for i in $(seq 1 30); do
  v=$(curl -s -o /dev/null -D - "$BASE/v1" | awk 'tolower($1)=="tape-mcp-version:"{gsub("\r","",$2); print $2}')
  if [ "$v" = "$NEW" ]; then n=$((n + 1)); [ $n -ge 5 ] && break; else n=0; fi
  sleep 2
done
[ $n -ge 5 ] || back "unpinned requests do not all reach $NEW at 100%"
smoke "$BASE/mcp" --mcp-version "$NEW" > "$STATE/smoke-mcp.out" 2>&1 || { cat "$STATE/smoke-mcp.out"; back "prod smoke"; }
cat "$STATE/smoke-mcp.out"
note "prod smoke ($BASE/mcp): $(tail -1 "$STATE/smoke-mcp.out")"
if curl -s -o /dev/null -D - -X POST "$TAPE_BASE/mcp" | grep -qi '^tape-mcp-version:'; then
  smoke "$TAPE_BASE/mcp" --mcp-version "$NEW" > "$STATE/smoke-mcp.out" 2>&1 || { cat "$STATE/smoke-mcp.out"; back "prod smoke through the tape Worker"; }
  cat "$STATE/smoke-mcp.out"
  note "prod smoke ($TAPE_BASE/mcp): $(tail -1 "$STATE/smoke-mcp.out")"
else
  note "$TAPE_BASE/mcp does not reach tape-mcp yet (no service binding deployed): not smoked there"
fi
node "$SCRIPTS/telemetry.ts" "$NEW" "$T0" --min 12 --service "$WORKER" > "$STATE/telemetry-mcp.out" 2>&1 || { cat "$STATE/telemetry-mcp.out"; back "telemetry over the run"; }
cat "$STATE/telemetry-mcp.out"
note "run: $(grep '^telemetry ' "$STATE/telemetry-mcp.out")"
OUTCOME=deployed
record
say "deployed $WORKER $NEW (git $SHA); previous $PREV; $(( ($(now_ms) - RUN_START_MS) / 1000 )) s"
