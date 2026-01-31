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
    exec npx tsx src/cli/ask.ts "$@"
    ;;
  *)
    exec npx tsx src/cli/main.ts "$@"
    ;;
esac
