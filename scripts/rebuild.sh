#!/usr/bin/env bash
# rebuild.sh — rebuild vendor + main, then restart ALL daemon instances.
# Each running daemon has its own CTI_HOME; we discover them from /proc
# and restart each one individually.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_BIN="$PROJECT_DIR/dist/daemon.mjs"

echo "==> Building vendor..."
(cd "$PROJECT_DIR/vendor/Claude-to-IM" && npm run build)

echo "==> Building main..."
(cd "$PROJECT_DIR" && npm run build)

# ── Discover running daemon instances and their CTI_HOME ──
HOMES=()
PIDS=$(pgrep -f "$DAEMON_BIN" 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  for pid in $PIDS; do
    home=$(cat /proc/$pid/environ 2>/dev/null | tr '\0' '\n' | grep '^CTI_HOME=' | head -1 | cut -d= -f2- || true)
    if [ -n "$home" ]; then
      HOMES+=("$home")
      echo "    Found daemon PID $pid → CTI_HOME=$home"
    else
      echo "    Found daemon PID $pid → no CTI_HOME (will use default)"
      HOMES+=("")
    fi
  done
fi

# Fallback: if no running daemons found, use default
if [ ${#HOMES[@]} -eq 0 ]; then
  HOMES=("${CTI_HOME:-$HOME/.claude-to-im}")
  echo "    No running daemons found, using default CTI_HOME=${HOMES[0]}"
fi

# ── Stop all instances ──
echo "==> Stopping ${#HOMES[@]} daemon(s)..."
for home in "${HOMES[@]}"; do
  h="${home:-${CTI_HOME:-$HOME/.claude-to-im}}"
  echo "    Stopping CTI_HOME=$h"
  CTI_HOME="$h" bash "$SCRIPT_DIR/daemon.sh" stop 2>/dev/null || true
done

# Kill any survivors
sleep 1
PIDS=$(pgrep -f "$DAEMON_BIN" 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "    Killing leftover processes: $PIDS"
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# ── Start all instances ──
echo "==> Starting ${#HOMES[@]} daemon(s)..."
for home in "${HOMES[@]}"; do
  h="${home:-${CTI_HOME:-$HOME/.claude-to-im}}"
  echo "    Starting CTI_HOME=$h"
  CTI_HOME="$h" bash "$SCRIPT_DIR/daemon.sh" start
done

echo "==> Done."
