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
    # Auto-restart on SIGKILL (137) so macOS memory pressure doesn't kill the server permanently
    while true; do
      if [ -f "$SCRIPT_DIR/dist/cli/ask.js" ]; then
        node "$SCRIPT_DIR/dist/cli/ask.js" "$@"
      else
        npx tsx src/cli/ask.ts "$@"
      fi
      EXIT_CODE=$?
      # Only restart on SIGKILL (137); exit normally for Ctrl-C (130) or clean exit (0)
      if [ $EXIT_CODE -eq 137 ]; then
        echo "⚠️  Server killed by OS (memory pressure), restarting in 3s..."
        sleep 3
      else
        break
      fi
    done
    ;;
  *)
    exec npx tsx src/cli/main.ts "$@"
    ;;
esac
