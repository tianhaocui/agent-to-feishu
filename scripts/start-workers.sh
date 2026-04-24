#!/bin/bash
set -e
cd /root/agent-to-feishu
for w in xiang-worker chou-worker tester-worker codex-worker; do
  home="/root/.$w"
  [ -f "$home/config.env" ] || continue
  mkdir -p "$home/data" "$home/logs" "$home/runtime"
  CTI_HOME="$home" nohup node dist/daemon.mjs >>"$home/logs/bridge.log" 2>&1 &
  echo "$w: $!"
done
sleep 5
for w in xiang-worker chou-worker tester-worker codex-worker; do
  echo "--- $w ---"
  cat "/root/.$w/runtime/status.json" 2>/dev/null || echo "no status"
done
