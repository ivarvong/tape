#!/usr/bin/env bash
# Deploy the tape Worker from one commit, on the fast path when the change allows it. It is the only Worker: the
# hosted compiler and runner (/mcp, /v1/{compile,run,feedback}; mcp/src) is served in it (until 2026-11-22 it was
# the tape-mcp Worker, deployed first by this script).
#   CLOUDFLARE_ACCOUNT_ID=<id> service/scripts/ship.sh "<message>" [--dry-run] [--ramp]
# As deploy.sh: a clean commit on main (or ALLOW_BRANCH=1) with a passing full-gate record (service/scripts/gate.sh),
# cf with the OAuth login (CLOUDFLARE_API_TOKEN unset), the same lock, the same deploy log.
#
#  1. preflight: a clean tree, the gate's record, the lock; the Worker one version at 100% (PREV); the live
#     observability settings are cloudflare.config.ts's (scripts/observability.ts: no upload or ramp applies them)
#  2. which path: the stepped ramp (deploy.sh's 10/50/100 with DWELL under the probe) when the diff from the commit
#     prod serves (its tape-version header) touches Durable Object classes, migrations or storage: service/src/name.ts,
#     service/src/program.ts, service/cloudflare.config.ts, any service/src file that names DurableObject or
#     ctx.storage, host.ts, host/, sql.ts, sql/; or when prod's commit is not known here; or with --ramp. Otherwise
#     0% -> 100% and a FAST_WINDOW (30 s) window under the probe, then the telemetry gate.
#  3. build, then upload NEW (in no deployment yet); NEW must have the TOKEN and IP_SALT secrets. --dry-run stops here.
#  4. 0% -> pinned smoke, pinned MCP smoke (/mcp on NEW, every answer naming NEW in tape-mcp-version), and parity
#     (scripts/parity.ts: the playground NEW serves and /mcp on NEW name the same commit and compiler and compile
#     alike) -> telemetry at 0% -> 100% (fast) or the ramp
#  5. at 100%: unpinned requests answer from NEW; the prod smokes (and /mcp); the telemetry gate over the run
# A failure in 4-5 rolls back to PREV, only while the deployment is still the one this run last wrote. One entry per
# run in $DEPLOY_LOG, with NEW and PREV and the step times.
set -euo pipefail
MSG=${1:?usage: CLOUDFLARE_ACCOUNT_ID=<id> service/scripts/ship.sh "<message>" [--dry-run] [--ramp]}
shift
DRY=0
FORCE_RAMP=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --ramp) FORCE_RAMP=1 ;;
    *) echo "unknown flag $a" >&2; exit 2 ;;
  esac
done
HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$HERE/.." && pwd)
SCRIPTS=$HERE/scripts
BASE=${BASE:-https://tape.ivar.workers.dev}
STATE=${TAPE_STATE:-$HOME/.local/state/tape}
DEPLOY_LOG=${DEPLOY_LOG:-$HOME/code/lab_notebook/tape-2026-11-21/deploys.md}
DWELL=${DWELL:-60}
FAST_WINDOW=${FAST_WINDOW:-30}
PROBE_RPS=${PROBE_RPS:-5}
STEPS=${STEPS:-"10 50 100"}
export WRANGLER_DOCKER_BIN=${WRANGLER_DOCKER_BIN:-/usr/bin/false}
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID (the account the OAuth login reaches); it is never written to the repo}"
export CLOUDFLARE_ACCOUNT_ID
cd "$HERE"
cf() { env -u CLOUDFLARE_API_TOKEN npx cf "$@"; }
now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
RUN_START_MS=$(now_ms)
say() { echo "== [$(( ($(now_ms) - RUN_START_MS) / 1000 ))s] $*"; }
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$STATE/runs"
RUN_LOG="$STATE/runs/$(date -u +%Y%m%dT%H%M%SZ)-ship.log"
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
echo "$$ ship $SHA $STAMP" > "$LOCK/who"
trap 'rm -rf "$LOCK"' EXIT INT TERM
say "ship $SHA ($BRANCH) \"$MSG\"; gate: $(sed -n 's/^at //p' "$STATE/gate/$FULL"); run log $RUN_LOG"

json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }
split_of() {  # split_of <worker>: its latest deployment as "id:pct id:pct"
  cf workers deployments list --worker "$1" --per-page 1 | json 'print(" ".join("%s:%g" % (v["version_id"], v["percentage"]) for v in d["deployments"][0]["versions"]))'
}
norm() { printf '%s\n' $1 | sort | tr '\n' ' '; }
WROTE=""
route() {  # route <id>:<pct> [<id>:<pct>]
  body=$(python3 -c 'import json,sys; print(json.dumps({"strategy":"percentage","versions":[{"version_id":a.split(":")[0],"percentage":int(a.split(":")[1])} for a in sys.argv[2:]],"annotations":{"workers/message":sys.argv[1][:100]}}))' "$MSG [git $SHA]" "$@")
  cf workers deployments create --worker tape --body "$body" > /dev/null
  WROTE="$*"
}
OUTCOME=failed
NOTES=""
note() { NOTES="$NOTES- $*
"; say "$*"; }
record() {
  mkdir -p "$(dirname "$DEPLOY_LOG")"
  [ -f "$DEPLOY_LOG" ] || printf '# tape deploys\n\nOne entry per deploy run (newest last).\n' > "$DEPLOY_LOG"
  {
    printf '\n## %s %s (tape, ship.sh, %s path)\n\n' "$STAMP" "$OUTCOME" "${PATH_KIND:-unknown}"
    printf -- '- message: %s\n- commit: %s (%s)\n- tape NEW: %s\n- tape PREV: %s\n- run log: %s\n' \
      "$MSG" "$SHA" "$BRANCH" "${NEW_tape:-none}" "${PREV_tape:-none}" "$RUN_LOG"
    if [ -n "$NOTES" ]; then printf '%s' "$NOTES"; fi
    printf -- '- took: %s s\n' "$(( ($(now_ms) - RUN_START_MS) / 1000 ))"
  } >> "$DEPLOY_LOG"
}
undo() {  # back to PREV, only if the deployment is still what this run wrote
  local now
  [ -n "$WROTE" ] || return 0
  [ "$(norm "$WROTE")" = "$(norm "$PREV_tape:100")" ] && return 0
  now=$(split_of tape || echo unknown)
  if [ "$(norm "$now")" = "$(norm "$WROTE")" ]; then
    route "$PREV_tape:100"
    note "rolled back tape: $PREV_tape 100% (the deployment was still $now, as this run left it)"
  else
    note "NOT rolled back tape: the deployment is $now, not the $WROTE this run wrote; someone else changed it"
    OUTCOME="failed, not rolled back"
  fi
}
back() {
  note "FAILED: $1"
  OUTCOME="rolled back"
  undo
  record
  exit 1
}

s=$(split_of tape)
case "$s" in *" "*|"") echo "tape's deployment is split ($s): finish or roll it back first" >&2; exit 1 ;; esac
[ "${s#*:}" = 100 ] || { echo "tape's deployment is $s, not one version at 100%" >&2; exit 1; }
PREV_tape=${s%%:*}
say "previous (rollback): tape $PREV_tape"
# observability is the script's setting, not a version's: this run's upload and ramp would never apply a change to
# it (traces stayed off after abd7729 shipped, 2026-11-23). Stop here until the live settings are the config's.
node scripts/observability.ts || { echo "ship.sh stops: the live observability settings are not cloudflare.config.ts's" >&2; exit 1; }

# ---- 2. which path
DEPLOYED=$(curl -s -o /dev/null -D - "$BASE/ivar/hello" | awk 'tolower($1)=="tape-version:"{gsub("\r","",$2); print $2}')
DEPLOYED=${DEPLOYED%-dirty}
RAMP_WHY=""
if [ "$FORCE_RAMP" = 1 ]; then
  RAMP_WHY="--ramp"
elif [ -z "$DEPLOYED" ] || ! git -C "$ROOT" cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
  RAMP_WHY="prod's commit (${DEPLOYED:-none}) is not known here"
else
  STORAGE=$(git -C "$ROOT" grep -l -E 'DurableObject|ctx\.storage' HEAD -- service/src | sed 's/^HEAD://' | tr '\n' ' ')
  stateful() {  # the changed files that the objects or their storage run
    while read -r f; do
      case " $STORAGE " in (*" $f "*) echo "$f"; continue ;; esac
      case "$f" in
        (service/src/name.ts|service/src/program.ts|service/cloudflare.config.ts|host.ts|host/*|sql.ts|sql/*) echo "$f" ;;
      esac
    done
  }
  TOUCHED=$(git -C "$ROOT" diff --name-only "$DEPLOYED" HEAD | stateful | tr '\n' ' ')
  [ -z "$TOUCHED" ] || RAMP_WHY="the diff from $DEPLOYED touches $TOUCHED"
fi
if [ -n "$RAMP_WHY" ]; then PATH_KIND=ramp; else PATH_KIND=fast; fi
note "path: $PATH_KIND (prod serves ${DEPLOYED:-unknown})${RAMP_WHY:+: $RAMP_WHY}"

# ---- 3. build, upload
say "build"
npm run build > "$STATE/build.log" 2>&1 || { tail -30 "$STATE/build.log"; note "tape build failed"; record; exit 1; }
grep -q "\"$SHA\"" .cloudflare/output/v0/workers/default/bundle/index.js || { note "the tape build does not carry $SHA"; record; exit 1; }
say "upload"
cf workers versions create --prebuilt --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" > "$STATE/upload.out" 2>&1 || { cat "$STATE/upload.out"; note "tape upload failed"; record; exit 1; }
uuid() { grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$1" | head -1; }
NEW_tape=$(uuid "$STATE/upload.out")
[ -n "$NEW_tape" ] || { cat "$STATE/upload.out"; note "no version id in the upload's output"; record; exit 1; }
say "new: tape $NEW_tape"
# a version just uploaded can answer 404 for a few seconds (seen twice on 2026-11-23): ask again before judging it
for _ in 1 2 3 4 5 6; do cf workers versions get "$NEW_tape" --worker tape > "$STATE/version.json" 2>/dev/null && break; sleep 3; done
json < "$STATE/version.json" 'import sys; b={x["name"]: x["type"] for x in d["bindings"]}; sys.exit(0 if b.get("TOKEN")=="secret_text" and b.get("IP_SALT")=="secret_text" and b.get("VERSION")=="version_metadata" else 1)' ||
  { note "tape NEW has no TOKEN or IP_SALT secret, or no VERSION binding"; record; exit 1; }
if [ "$DRY" = 1 ]; then
  OUTCOME="dry run (uploaded, not routed)"
  note "dry run: stopped before routing any traffic"
  record
  say "dry run done: tape $NEW_tape uploaded, in no deployment"
  exit 0
fi

all_from() {  # all_from <url> <header> <id> [curl args: -X POST, a pin header]: five answers in a row from that version
  local n=0
  for _ in $(seq 1 30); do
    v=$(curl -s -o /dev/null -D - -H "x-tape-synthetic: deploy" "${@:4}" "$1" | awk -v h="$2:" 'tolower($1)==h{gsub("\r","",$2); print $2}')
    if [ "$v" = "$3" ]; then n=$((n + 1)); [ $n -ge 5 ] && return 0; else n=0; fi
    sleep 2
  done
  return 1
}

# ---- 4. tape at 0%
route "$PREV_tape:100" "$NEW_tape:0"
T0=$(now_ms)
say "tape: $NEW_tape 0%; pinned smoke, MCP, parity"
# five pinned answers in a row from NEW, not one: a deployment reaches the edge's machines one by one, and a pinned
# request to a machine that has not got it yet is answered by the 100% version. One answer was the gate until
# 2026-11-23, when three ships in a row failed their pinned MCP smoke on it: 3 of 78 checks answered by 67796d9c, up
# to 5.5 s after the first pinned answer from the new version (Workers Observability, the smoke's invocations), on
# every route (/ivar/hello, /mcp, /v1/run, the playground's files) and not on the same calls twice.
all_from "$BASE/ivar/hello" tape-worker-version "$NEW_tape" -H "cloudflare-workers-version-overrides: tape=\"$NEW_tape\"" || back "pinned requests did not all reach tape $NEW_tape (five in a row, within 60 s)"
node scripts/smoke.ts "$BASE" --pin "$NEW_tape" --sha "$SHA" > "$STATE/smoke.out" 2>&1 &
S1=$!
node scripts/mcp-smoke.ts "$BASE/mcp" --pin "tape=$NEW_tape" --mcp-version "$NEW_tape" > "$STATE/smoke-binding.out" 2>&1 &
S2=$!
node scripts/parity.ts "$BASE" --pin "$NEW_tape" --sha "$SHA" > "$STATE/parity.out" 2>&1 &
S3=$!
wait $S1 || { cat "$STATE/smoke.out"; back "tape pinned smoke"; }
wait $S2 || { cat "$STATE/smoke-binding.out"; back "pinned MCP smoke"; }
wait $S3 || { cat "$STATE/parity.out"; back "parity: the playground and /mcp do not compile alike"; }
note "tape pinned smoke: $(tail -1 "$STATE/smoke.out"); MCP: $(tail -1 "$STATE/smoke-binding.out"); parity: $(tail -1 "$STATE/parity.out")"
node scripts/telemetry.ts "$NEW_tape" "$T0" --min 5 --prev "$PREV_tape" > "$STATE/telemetry.out" 2>&1 || { cat "$STATE/telemetry.out"; back "tape telemetry at 0%"; }
note "tape 0%: $(grep '^telemetry ' "$STATE/telemetry.out")"

# ---- 4b. tape to 100%: fast, or the ramp
if [ "$PATH_KIND" = fast ]; then STEP_LIST=100; WINDOW=$FAST_WINDOW; else STEP_LIST=$STEPS; WINDOW=$DWELL; fi
for pct in $STEP_LIST; do
  if [ "$pct" = 100 ]; then route "$NEW_tape:100"; else route "$PREV_tape:$((100 - pct))" "$NEW_tape:$pct"; fi
  TS=$(now_ms)
  say "tape: $NEW_tape $pct%; ${WINDOW}s under the probe"
  node scripts/probe.ts "$BASE" "$WINDOW" --rps "$PROBE_RPS" --new "$NEW_tape" --prev "$PREV_tape" --sha "$SHA" > "$STATE/probe.out" 2>&1 || { cat "$STATE/probe.out"; back "probe at $pct%"; }
  note "$pct%: $(grep '^probe ' "$STATE/probe.out")"
  node scripts/telemetry.ts "$NEW_tape" "$TS" --min 1 --prev "$PREV_tape" > "$STATE/telemetry.out" 2>&1 || { cat "$STATE/telemetry.out"; back "telemetry at $pct%"; }
  note "$pct%: $(grep '^telemetry ' "$STATE/telemetry.out")"
done

# ---- 4c. at 100%: every live program built with NEW's compiler now (POST /_rebuild), so no request pays for it.
# A compiler change made the first request to each name rebuild it from source, 1.2-4 s on prod (2026-11-23). It
# is recorded, not a reason to roll back: a name it misses still rebuilds on its first request, as before.
TOKEN_FILE=${TAPE_TOKEN_FILE:-$HOME/.config/tape/operator-token}
# An object still on the version before answers "does not implement" (counted as `older`; the first call of 764f3a70's
# run threw on one): the walk is made again 30 s later, once, when the call failed or met one.
rebuild_call() {
  curl -sS --max-time 900 -X POST -H "authorization: Bearer $(cat "$TOKEN_FILE")" -H 'content-type: application/json' \
    --data '{"concurrency": 4, "accounts": ["ivar", "demo"]}' "$BASE/_rebuild" > "$STATE/rebuild.out" 2>&1 &&
    json < "$STATE/rebuild.out" 'sys.exit(0 if d.get("older", 0) == 0 else 1)' 2>/dev/null
}
if [ -r "$TOKEN_FILE" ]; then
  say "rebuild: every live name with tape $NEW_tape's compiler"
  if rebuild_call || { sleep 30; say "rebuild: again"; rebuild_call; }; then :; fi
  note "rebuild: $(json < "$STATE/rebuild.out" 'print("%d names (%d accounts), %d versions: %d rebuilt, %d failed (%s), %d older, %d errors, %.1f s; slowest %s" % (d["names"], d["accounts"], d["versions"], d["rebuilt"], d["failed"], ", ".join(sorted(set(f["name"] for f in d.get("failures", [])))) or "none", d.get("older", 0), len(d["errors"]), d["ms"] / 1000, ", ".join("%s %d ms" % (x["name"], x["ms"]) for x in d["slowest"][:3])))' 2>&1 || head -c 300 "$STATE/rebuild.out")"
else
  note "rebuild: skipped, no operator token at $TOKEN_FILE"
fi

# ---- 5. at 100%
all_from "$BASE/ivar/hello" tape-worker-version "$NEW_tape" || back "unpinned requests do not all reach tape $NEW_tape"
say "prod smokes"
node scripts/smoke.ts "$BASE" --sha "$SHA" > "$STATE/smoke.out" 2>&1 &
S1=$!
node scripts/mcp-smoke.ts "$BASE/mcp" --mcp-version "$NEW_tape" > "$STATE/smoke-binding.out" 2>&1 &
S3=$!
node scripts/parity.ts "$BASE" --sha "$SHA" > "$STATE/parity.out" 2>&1 &
S4=$!
wait $S1 || { cat "$STATE/smoke.out"; back "tape prod smoke"; }
wait $S3 || { cat "$STATE/smoke-binding.out"; back "prod MCP smoke"; }
wait $S4 || { cat "$STATE/parity.out"; back "prod parity"; }
note "prod smoke: $(tail -1 "$STATE/smoke.out"); MCP: $(tail -1 "$STATE/smoke-binding.out"); parity: $(tail -1 "$STATE/parity.out")"
node scripts/telemetry.ts "$NEW_tape" "$T0" --min 10 --prev "$PREV_tape" > "$STATE/telemetry.out" 2>&1 || { cat "$STATE/telemetry.out"; back "tape telemetry over the run"; }
note "tape run: $(grep '^telemetry ' "$STATE/telemetry.out"); $(grep 'durable object' "$STATE/telemetry.out" | sed 's/^ *//')"
OUTCOME=deployed
record
say "deployed tape $NEW_tape (previous $PREV_tape), git $SHA, $PATH_KIND path"
