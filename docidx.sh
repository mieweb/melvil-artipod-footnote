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
    # Extract --port value from args (default 3000) for port-clearing on restart
    SERVE_PORT=3000
    for arg in "$@"; do
      case "$PREV_ARG" in --port|-p) SERVE_PORT="$arg" ;; esac
      PREV_ARG="$arg"
    done
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
        lsof -ti :"$SERVE_PORT" | xargs kill -9 2>/dev/null
        sleep 1
      else
        break
      fi
    done
    ;;
  *)
    exec npx tsx src/cli/main.ts "$@"
    ;;
esac
