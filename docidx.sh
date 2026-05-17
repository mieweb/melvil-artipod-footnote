#!/usr/bin/env bash
# docidx CLI wrapper
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

case "$1" in
  test)
    shift
    exec npx tsx src/cli/test-search.ts "$@"
    ;;
  ask)
    shift
    # Use compiled dist/ if available (lighter than tsx); fall back to tsx for dev
    if [ -f "$SCRIPT_DIR/dist/cli/ask.js" ]; then
      exec node "$SCRIPT_DIR/dist/cli/ask.js" "$@"
    else
      exec npx tsx src/cli/ask.ts "$@"
    fi
    ;;
  *)
    exec npx tsx src/cli/main.ts "$@"
    ;;
esac
