#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${HWAI_GREG_DOGFOOD_LABEL:-ai.humanswith.hwai-greg-dogfood-daily}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.hwai/token-efficiency-platform/logs"
HOUR="${HWAI_GREG_DOGFOOD_HOUR:-19}"
MINUTE="${HWAI_GREG_DOGFOOD_MINUTE:-0}"

usage() {
  cat <<USAGE
Usage:
  scripts/greg-dogfood-automeasurement.sh install [--hour=19] [--minute=0]
  scripts/greg-dogfood-automeasurement.sh uninstall
  scripts/greg-dogfood-automeasurement.sh status
  scripts/greg-dogfood-automeasurement.sh run-now
  scripts/greg-dogfood-automeasurement.sh catch-up [--days=7]

Installs a local macOS LaunchAgent that generates Greg's daily HWAI Context
Router token-efficiency report and dogfood note automatically.

Outputs:
  $HOME/.hwai/token-efficiency-platform/daily/<date>/
  $HOME/.hwai/token-efficiency-platform/logs/
USAGE
}

command="${1:-}"
if [[ -n "$command" ]]; then
  shift || true
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hour=*)
      HOUR="${1#*=}"
      shift
      ;;
    --hour)
      HOUR="${2:-}"
      shift 2
      ;;
    --minute=*)
      MINUTE="${1#*=}"
      shift
      ;;
    --minute)
      MINUTE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

validate_time() {
  if ! [[ "$HOUR" =~ ^[0-9]+$ ]] || (( HOUR < 0 || HOUR > 23 )); then
    echo "Invalid --hour=$HOUR; expected 0..23" >&2
    exit 2
  fi
  if ! [[ "$MINUTE" =~ ^[0-9]+$ ]] || (( MINUTE < 0 || MINUTE > 59 )); then
    echo "Invalid --minute=$MINUTE; expected 0..59" >&2
    exit 2
  fi
}

bootout_if_loaded() {
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
}

write_plist() {
  mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR"
  cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT_DIR/scripts/greg-dogfood-catchup.sh</string>
    <string>--days=7</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/greg-dogfood-daily.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/greg-dogfood-daily.err.log</string>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST_PATH" >/dev/null
}

install_agent() {
  validate_time
  write_plist
  bootout_if_loaded
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  echo "Installed HWAI Greg dogfood automeasurement LaunchAgent."
  echo "Schedule: daily at $(printf '%02d:%02d' "$HOUR" "$MINUTE") local time"
  echo "Plist: $PLIST_PATH"
  echo "Daily output: $HOME/.hwai/token-efficiency-platform/daily/<date>/"
}

uninstall_agent() {
  bootout_if_loaded
  rm -f "$PLIST_PATH"
  echo "Uninstalled HWAI Greg dogfood automeasurement LaunchAgent."
}

status_agent() {
  echo "Label: $LABEL"
  echo "Plist: $PLIST_PATH"
  if [[ -f "$PLIST_PATH" ]]; then
    echo "Plist exists: yes"
    plutil -lint "$PLIST_PATH"
  else
    echo "Plist exists: no"
  fi
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "LaunchAgent loaded: yes"
  else
    echo "LaunchAgent loaded: no"
  fi
}

run_now() {
  "$ROOT_DIR/scripts/greg-dogfood-catchup.sh" --days=7 --force
}

catch_up() {
  "$ROOT_DIR/scripts/greg-dogfood-catchup.sh" "$@"
}

case "$command" in
  install)
    install_agent
    ;;
  uninstall)
    uninstall_agent
    ;;
  status)
    status_agent
    ;;
  run-now)
    run_now
    ;;
  catch-up)
    catch_up "$@"
    ;;
  ""|--help|-h)
    usage
    ;;
  *)
    echo "Unknown command: $command" >&2
    usage >&2
    exit 2
    ;;
esac
