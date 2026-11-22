#!/usr/bin/env bash
# Deploy the tape Worker (https://tape.ivar.workers.dev) through a 0% version and a stepped ramp.
#   CLOUDFLARE_ACCOUNT_ID=<id> service/scripts/deploy.sh "<message>"
# The commit must be clean and have passed the full gate (service/scripts/gate.sh writes the record this reads). Not
# on main, it needs ALLOW_BRANCH=1. Runs cf with the OAuth login (CLOUDFLARE_API_TOKEN unset).
#
#  1. preflight: a clean tree, the gate's record for this commit, nothing else deploying (a lock), cf logged in
#  2. PREV: the version serving 100% (the deployment must not be split); it is what a rollback restores
#  3. build (the site and the Worker, tape-version = the commit) and upload NEW (cf workers versions create): in no
#     deployment yet; NEW must have the TOKEN secret
#  4. route PREV 100% / NEW 0%
#  5. pinned smoke (scripts/smoke.ts --pin NEW --sha <commit>): the Worker and its static assets as NEW serves them.
#     The Durable Objects still run PREV: an object runs the version the deployment gave its id, whatever version
#     the override header pins the Worker to, so this smoke is NEW's Worker against PREV's objects, as in the ramp.
#  6. telemetry gate on NEW (scripts/telemetry.ts): no invocation not ok, no 5xx but the 503s a deploy's object reset
#     gives (logged tape.stopped), no error logs; and which version the objects ran
#  7. ramp 10% -> 50% -> 100% (PREV first in every split, so an object given NEW keeps it): at each step a dwell of
#     DWELL seconds under the probe (scripts/probe.ts, unpinned, PROBE_RPS a second), then the telemetry gate on NEW
#  8. at 100%: wait until unpinned requests answer from NEW, the prod smoke unpinned, the telemetry gate over the run
# A failure in 4-8 routes 100% back to PREV, but only while the deployment is still the one this run last wrote (no
# one else's deployment is touched), and nothing but PREV is restored. Each run appends to $DEPLOY_LOG.
# Rollback by hand (to the PREV a run recorded):
#   env -u CLOUDFLARE_API_TOKEN npx cf workers deployments create --worker tape \
#     --body '{"strategy":"percentage","versions":[{"version_id":"<PREV>","percentage":100}]}'
set -euo pipefail
MSG=${1:?usage: CLOUDFLARE_ACCOUNT_ID=<id> scripts/deploy.sh "<message>"}
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/.." && pwd)
BASE=${BASE:-https://tape.ivar.workers.dev}
WORKER=tape
STATE=${TAPE_STATE:-$HOME/.local/state/tape}
DEPLOY_LOG=${DEPLOY_LOG:-$HOME/code/lab_notebook/tape-2026-11-21/deploys.md}
DWELL=${DWELL:-60}
PROBE_RPS=${PROBE_RPS:-5}
STEPS=${STEPS:-"10 50 100"}
# the Vite plugin asks docker for old build images, and a docker CLI without its daemon hangs the build; the tape
# Worker has no containers
export WRANGLER_DOCKER_BIN=${WRANGLER_DOCKER_BIN:-/usr/bin/false}
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (the account the OAuth login reaches); it is never written to the repo}"
export CLOUDFLARE_ACCOUNT_ID
cd "$HERE"
cf() { env -u CLOUDFLARE_API_TOKEN npx cf "$@"; }
say() { echo "== $*"; }
RUN_START_MS=$(python3 -c 'import time; print(int(time.time() * 1000))')
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$STATE/runs"
RUN_LOG="$STATE/runs/$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$RUN_LOG") 2>&1

# ---- 1. preflight
[ -z "$(git -C "$ROOT" status --porcelain)" ] || { echo "the tree is not clean" >&2; exit 1; }
FULL=$(git -C "$ROOT" rev-parse HEAD)
SHA=$(git -C "$ROOT" rev-parse --short=12 HEAD)
BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = main ] || [ "${ALLOW_BRANCH:-}" = 1 ] || { echo "not on main ($BRANCH): ALLOW_BRANCH=1 to deploy it" >&2; exit 1; }
[ -f "$STATE/gate/$FULL" ] || { echo "no gate record for $SHA: run service/scripts/gate.sh first" >&2; exit 1; }
grep -qE " passed, 0 failed," "$STATE/gate/$FULL" || { cat "$STATE/gate/$FULL"; echo "the gate record for $SHA is not a pass" >&2; exit 1; }
mkdir -p "$STATE"
LOCK="$STATE/deploy.lock"
mkdir "$LOCK" 2>/dev/null || { echo "another deploy holds $LOCK ($(cat "$LOCK/who" 2>/dev/null))" >&2; exit 1; }
echo "$$ $SHA $STAMP" > "$LOCK/who"
trap 'rm -rf "$LOCK"' EXIT INT TERM
say "deploy $SHA ($BRANCH) \"$MSG\"; gate: $(sed -n 's/^at //p' "$STATE/gate/$FULL"); run log $RUN_LOG"

json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
latest() { cf workers deployments list --worker "$WORKER" --per-page 1; }
# the latest deployment as "id:pct id:pct"
split_of() { latest | json 'print(" ".join("%s:%g" % (v["version_id"], v["percentage"]) for v in d["deployments"][0]["versions"]))'; }
WROTE=""
norm() { printf '%s\n' $1 | sort | tr '\n' ' '; }  # a split, in a fixed order
route() {  # route <id>:<pct> [<id>:<pct>]
  body=$(python3 -c 'import json,sys; print(json.dumps({"strategy":"percentage","versions":[{"version_id":a.split(":")[0],"percentage":int(a.split(":")[1])} for a in sys.argv[2:]],"annotations":{"workers/message":sys.argv[1][:100]}}))' "$MSG [git $SHA]" "$@")
  cf workers deployments create --worker "$WORKER" --body "$body" > /dev/null
  WROTE="$*"
}
OUTCOME=failed
record() {  # one entry per run in the deploy log
  mkdir -p "$(dirname "$DEPLOY_LOG")"
  [ -f "$DEPLOY_LOG" ] || printf '# tape deploys\n\nOne entry per run of service/scripts/deploy.sh (newest last).\n' > "$DEPLOY_LOG"
  {
    printf '\n## %s %s\n\n' "$STAMP" "$OUTCOME"
    printf -- '- message: %s\n- commit: %s (%s)\n- NEW: %s\n- PREV: %s\n- run log: %s\n' "$MSG" "$SHA" "$BRANCH" "${NEW:-none}" "${PREV:-none}" "$RUN_LOG"
    if [ -n "${NOTES:-}" ]; then printf '%s\n' "$NOTES"; fi
  } >> "$DEPLOY_LOG"
}
NOTES=""
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
npm run build > "$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; record; exit 1; }
grep -q "\"$SHA\"" .cloudflare/output/v0/workers/default/bundle/index.js || { echo "the build does not carry $SHA" >&2; record; exit 1; }
say "upload"
out=$(cf workers versions create --prebuilt --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" 2>&1) || { echo "$out"; record; exit 1; }
NEW=$(printf '%s\n' "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
[ -n "$NEW" ] || { echo "$out"; echo "no version id in the upload's output" >&2; record; exit 1; }
say "new: $NEW"
cf workers versions get "$NEW" --worker "$WORKER" | json 'import sys; sys.exit(0 if any(b["name"]=="TOKEN" and b["type"]=="secret_text" for b in d["bindings"]) else 1)' ||
  { note "NEW has no TOKEN secret"; record; exit 1; }

# ---- 4. 0%
route "$PREV:100" "$NEW:0"
say "routed $NEW 0% beside $PREV 100%"
T0=$(python3 -c 'import time; print(int(time.time() * 1000))')

# ---- 5. pinned smoke
say "pinned smoke"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  v=$(curl -s -o /dev/null -D - -H "x-tape-synthetic: deploy" -H "cloudflare-workers-version-overrides: $WORKER=\"$NEW\"" "$BASE/ivar/hello" | awk 'tolower($1)=="tape-worker-version:"{gsub("\r","",$2); print $2}')
  [ "$v" = "$NEW" ] && { ok=1; break; }
  sleep 3
done
[ $ok = 1 ] || back "pinned requests never reached $NEW"
node scripts/smoke.ts "$BASE" --pin "$NEW" --sha "$SHA" || back "pinned smoke"

# ---- 6. telemetry on NEW
say "telemetry gate (0%)"
node scripts/telemetry.ts "$NEW" "$T0" --min 5 --prev "$PREV" || back "telemetry at 0%"

# ---- 7. ramp
for pct in $STEPS; do
  if [ "$pct" = 100 ]; then route "$NEW:100"; else route "$PREV:$((100 - pct))" "$NEW:$pct"; fi
  TS=$(python3 -c 'import time; print(int(time.time() * 1000))')
  say "ramp: $NEW $pct%; dwell ${DWELL}s under the probe"
  node scripts/probe.ts "$BASE" "$DWELL" --rps "$PROBE_RPS" --new "$NEW" --prev "$PREV" --sha "$SHA" > "$STATE/probe.out" 2>&1 || { cat "$STATE/probe.out"; back "probe at $pct%"; }
  cat "$STATE/probe.out"
  note "$pct%: $(grep '^probe ' "$STATE/probe.out")"
  node scripts/telemetry.ts "$NEW" "$TS" --min 1 --prev "$PREV" > "$STATE/telemetry.out" 2>&1 || { cat "$STATE/telemetry.out"; back "telemetry at $pct%"; }
  cat "$STATE/telemetry.out"
  note "$pct%: $(grep '^telemetry ' "$STATE/telemetry.out")"
done

# ---- 8. at 100%
n=0
for i in $(seq 1 30); do
  v=$(curl -s -o /dev/null -D - -H "x-tape-synthetic: deploy" "$BASE/ivar/hello" | awk 'tolower($1)=="tape-worker-version:"{gsub("\r","",$2); print $2}')
  if [ "$v" = "$NEW" ]; then n=$((n + 1)); [ $n -ge 5 ] && break; else n=0; fi
  sleep 2
done
[ $n -ge 5 ] || back "unpinned requests do not all reach $NEW at 100%"
say "prod smoke"
node scripts/smoke.ts "$BASE" --sha "$SHA" > "$STATE/smoke.out" 2>&1 || { cat "$STATE/smoke.out"; back "prod smoke"; }
cat "$STATE/smoke.out"
note "prod smoke: $(tail -1 "$STATE/smoke.out")"
node scripts/telemetry.ts "$NEW" "$T0" --min 10 --prev "$PREV" > "$STATE/telemetry.out" 2>&1 || { cat "$STATE/telemetry.out"; back "telemetry over the run"; }
cat "$STATE/telemetry.out"
note "run: $(grep '^telemetry ' "$STATE/telemetry.out"); $(grep 'durable object' "$STATE/telemetry.out" | sed 's/^ *//')"
OUTCOME=deployed
record
say "deployed $NEW (git $SHA); previous $PREV; $(( ($(python3 -c 'import time; print(int(time.time() * 1000))') - RUN_START_MS) / 1000 )) s"
