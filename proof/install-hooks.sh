#!/bin/sh
# proof/install-hooks.sh (npm run hooks): opt in to the pre-commit check, proof/fast.ts --staged (format, lint and
# types for the files staged, in seconds). git commit --no-verify skips it once; delete the hook to opt out.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
HOOKS=$(cd "$ROOT" && git rev-parse --git-path hooks)
case "$HOOKS" in /*) ;; *) HOOKS="$ROOT/$HOOKS" ;; esac
mkdir -p "$HOOKS"
cat > "$HOOKS/pre-commit" <<'HOOK'
#!/bin/sh
# installed by proof/install-hooks.sh: format, lint and types for what is staged
exec node "$(git rev-parse --show-toplevel)/proof/fast.ts" --staged
HOOK
chmod +x "$HOOKS/pre-commit"
echo "pre-commit hook installed at $HOOKS/pre-commit (git commit --no-verify skips it)"
