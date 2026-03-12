#!/usr/bin/env bash
set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/feenix-fe-host.log"
PID_FILE="$SCRIPT_DIR/.log-collector.pid"
REPO_URL="https://github.com/PhoenixBlockChain/FeenixFEHost.git"
BRANCH="main"

# ─── Helpers ─────────────────────────────────────────────────────────────────
_start_log_collector() {
  _stop_log_collector

  # Background process: snapshot last 1000 lines from Docker logs every 10s
  # File never grows beyond ~1000 lines per service
  (
    while true; do
      docker compose -f "$SCRIPT_DIR/docker-compose.yml" \
        logs --tail 1000 --no-color --timestamps \
        > "$LOG_FILE.tmp" 2>&1 \
        && mv "$LOG_FILE.tmp" "$LOG_FILE"
      sleep 10
    done
  ) &
  echo $! > "$PID_FILE"
}

_stop_log_collector() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  rm -f "$LOG_FILE.tmp"
}

_is_running() {
  cd "$SCRIPT_DIR"
  docker compose ps --status running --quiet 2>/dev/null | grep -q .
}

# ─── Commands ────────────────────────────────────────────────────────────────

cmd_start() {
  echo "=== Feenix FE Host — Starting ==="
  cd "$SCRIPT_DIR"

  # Pull latest
  echo "[1/3] Pulling latest from $REPO_URL ($BRANCH)..."
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"

  # Build and launch
  echo "[2/3] Building and starting containers..."
  docker compose up -d --build --remove-orphans

  # Log collector
  echo "[3/3] Starting log collector..."
  _start_log_collector

  echo ""
  echo "Feenix FE Host is running."
  echo "  Nginx listening on :80"
  echo "  Poller polling every 60s"
  echo "  Logs:    $LOG_FILE"
  echo ""
  echo "  ./runner.sh logs     — view logs"
  echo "  ./runner.sh stop     — stop"
  echo "  ./runner.sh restart  — pull latest & restart"
}

cmd_stop() {
  echo "=== Feenix FE Host — Stopping ==="
  cd "$SCRIPT_DIR"

  _stop_log_collector
  docker compose down

  echo "Stopped."
}

cmd_restart() {
  cmd_stop
  echo ""
  cmd_start
}

cmd_logs() {
  if [ -f "$LOG_FILE" ]; then
    tail -n 1000 "$LOG_FILE"
  else
    echo "No log file found. Is the FE Host running?"
    echo "  Start with: ./runner.sh start"
  fi
}

cmd_status() {
  cd "$SCRIPT_DIR"
  if _is_running; then
    echo "Feenix FE Host is RUNNING"
    docker compose ps
  else
    echo "Feenix FE Host is STOPPED"
  fi
}

# ─── Entry ───────────────────────────────────────────────────────────────────
case "${1:-help}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  logs)    cmd_logs ;;
  status)  cmd_status ;;
  *)
    echo "Feenix FE Host — serves every app at <app_name>.feenix.network"
    echo ""
    echo "Usage: ./runner.sh {start|stop|restart|logs|status}"
    echo ""
    echo "  start   — Pull latest code, build containers, start services"
    echo "  stop    — Stop all services"
    echo "  restart — Pull latest, rebuild, restart (zero-downtime update)"
    echo "  logs    — Print last 1000 log lines"
    echo "  status  — Show whether services are running"
    ;;
esac
