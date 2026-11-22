#!/bin/sh
# The full gate for the commit checked out, recorded for scripts/deploy.sh, which deploys only a commit that passed it.
#   service/scripts/gate.sh
# Runs `npm run check` (node proof/all.ts, every part, ~10 min) at the repository's root on a clean tree; on success
# writes ~/.local/state/tape/gate/<full sha> with its last lines. The tree must still be clean when it ends.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
STATE=${TAPE_STATE:-$HOME/.local/state/tape}
cd "$ROOT"
[ -z "$(git status --porcelain)" ] || { echo "the tree is not clean: commit first" >&2; exit 1; }
SHA=$(git rev-parse HEAD)
mkdir -p "$STATE/gate"
LOG="$STATE/gate/$SHA.log"
echo "== gate @ $(git rev-parse --short=12 HEAD), log $LOG"
start=$(date +%s)
if ! NODE_NO_WARNINGS=1 npm run check > "$LOG" 2>&1; then
  tail -40 "$LOG"
  echo "GATE FAILED" >&2
  exit 1
fi
[ "$(git rev-parse HEAD)" = "$SHA" ] && [ -z "$(git status --porcelain)" ] ||
  { echo "the tree changed while the gate ran" >&2; exit 1; }
{ echo "sha $SHA"; echo "at $(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "took $(( $(date +%s) - start )) s"; tail -3 "$LOG"; } > "$STATE/gate/$SHA"
cat "$STATE/gate/$SHA"
