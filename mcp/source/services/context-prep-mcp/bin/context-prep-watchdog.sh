#!/usr/bin/env bash
set -euo pipefail

SERVICE_UNIT="${CONTEXT_PREP_WATCHDOG_SERVICE_UNIT:-context-prep-mcp.service}"
WATCHDOG_TIMER_UNIT="${CONTEXT_PREP_WATCHDOG_TIMER_UNIT:-context-prep-mcp-watchdog.timer}"
HEALTH_URL="${CONTEXT_PREP_WATCHDOG_HEALTH_URL:-http://127.0.0.1:3394/health}"
STATE_DIR="${CONTEXT_PREP_WATCHDOG_STATE_DIR:-/var/lib/context-prep-mcp-watchdog}"
FAIL_COUNT_FILE="${STATE_DIR}/fail-count"
MAX_FAILURES="${CONTEXT_PREP_WATCHDOG_MAX_FAILURES:-2}"
LOGGER_TAG="${CONTEXT_PREP_WATCHDOG_LOG_TAG:-context-prep-watchdog}"

mkdir -p "${STATE_DIR}"

log() {
  local message="$1"
  logger -t "${LOGGER_TAG}" "${message}"
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${message}"
}

read_fail_count() {
  if [[ -f "${FAIL_COUNT_FILE}" ]]; then
    cat "${FAIL_COUNT_FILE}"
  else
    printf '0\n'
  fi
}

write_fail_count() {
  printf '%s\n' "$1" > "${FAIL_COUNT_FILE}"
}

health_check() {
  local body

  if ! body="$(curl -fsS --max-time 8 "${HEALTH_URL}")"; then
    return 1
  fi

  grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<< "${body}" &&
    grep -Eq '"service"[[:space:]]*:[[:space:]]*"context-prep-mcp"' <<< "${body}"
}

ensure_timer_enabled() {
  local unit="$1"

  if ! systemctl is-enabled --quiet "${unit}"; then
    log "Enabling ${unit}"
    systemctl enable --now "${unit}"
    return
  fi

  if ! systemctl is-active --quiet "${unit}"; then
    log "Starting inactive timer ${unit}"
    systemctl start "${unit}"
  fi
}

restart_service() {
  log "Restarting ${SERVICE_UNIT}"
  systemctl reset-failed "${SERVICE_UNIT}" || true
  systemctl restart "${SERVICE_UNIT}"
  sleep 2
}

ensure_timer_enabled "${WATCHDOG_TIMER_UNIT}"

if ! systemctl is-enabled --quiet "${SERVICE_UNIT}"; then
  log "Enabling ${SERVICE_UNIT}"
  systemctl enable "${SERVICE_UNIT}"
fi

fail_count="$(read_fail_count)"
repair_needed=0

if ! systemctl is-active --quiet "${SERVICE_UNIT}"; then
  log "${SERVICE_UNIT} is not active"
  repair_needed=1
fi

if health_check; then
  if [[ "${fail_count}" != "0" ]]; then
    log "Health recovered; resetting failure counter"
  fi
  write_fail_count 0
  exit 0
fi

fail_count=$((fail_count + 1))
write_fail_count "${fail_count}"
log "Health check failed (${fail_count}/${MAX_FAILURES}) for ${HEALTH_URL}"

if (( fail_count < MAX_FAILURES )) && (( repair_needed == 0 )); then
  exit 0
fi

restart_service

if health_check; then
  write_fail_count 0
  log "Service recovery succeeded"
  exit 0
fi

log "Service recovery failed; leaving failure counter at ${fail_count}"
exit 1
