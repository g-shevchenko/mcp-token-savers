#!/usr/bin/env bash
set -euo pipefail

# install-token-efficiency-collector.sh
#
# Builds a standalone, TCC-safe copy of the daily token-efficiency readiness
# aggregator into a non-TCC directory so it can run under launchd.
#
# WHY: this repo working clone lives under ~/Documents, which macOS TCC
# protects. launchd-spawned processes cannot read ~/Documents
# ("Operation not permitted"), so the LaunchAgent that runs the daily
# readiness catch-up has never worked from the clone. This installer copies
# the small, node-builtins-only closure (preserving the relative layout the
# scripts compute via ROOT_DIR) into ~/.hwai/token-efficiency-collector/,
# which is outside TCC scope.
#
# Run this from an INTERACTIVE shell (it has Documents access). launchd then
# runs only the installed copy, never ~/Documents.
#
# Idempotent. Exits non-zero on any missing source file.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

INSTALL_DIR="${HWAI_TEC_INSTALL_DIR:-$HOME/.hwai/token-efficiency-collector}"
MANIFEST_SRC="${HWAI_TEC_MANIFEST:-$REPO_ROOT/mcp/manifest.json}"
MODE="install"

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-token-efficiency-collector.sh [--manifest=/path/to/manifest.json]
                                                [--install-dir=/path]
                                                [--check]

Copies the daily readiness aggregator closure into a non-TCC directory
(default ~/.hwai/token-efficiency-collector/) so launchd can run it.

Options:
  --manifest=PATH    MCP scope manifest to install as <root>/mcp/manifest.json
                     Default: this repo's public mcp/manifest.json (17 utility
                     MCPs). Internal callers pass the monorepo private manifest.
  --install-dir=PATH Target directory. Default ~/.hwai/token-efficiency-collector
  --check            Do not install. Verify that an existing install is
                     byte-identical (md5) to the current repo source closure.
                     Exit 0 if in sync, non-zero if drift / missing.
  --help|-h

Environment overrides:
  HWAI_TEC_INSTALL_DIR, HWAI_TEC_MANIFEST
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest=*) MANIFEST_SRC="${1#*=}"; shift ;;
    --manifest) MANIFEST_SRC="${2:-}"; shift 2 ;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --check) MODE="check"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# Closure: relative paths under REPO_ROOT that must exist in the install with
# the SAME relative layout (the scripts compute ROOT_DIR as their dir's parent
# and reference $ROOT_DIR/scripts/* + $ROOT_DIR/mcp/source/scripts/* +
# $ROOT_DIR/mcp/manifest.json).
SCRIPTS_CLOSURE=(
  "scripts/greg-dogfood-catchup.sh"
  "scripts/greg-dogfood-daily-note.sh"
  "scripts/greg-dogfood-measurement-readiness.mjs"
  "scripts/greg-dogfood-weekly-rollup.mjs"
  "scripts/greg-dogfood-review-queue.mjs"
  "scripts/token-efficiency-report.sh"
  "scripts/hwai-mcp-coverage-report.mjs"
)
SOURCE_SCRIPTS_CLOSURE=(
  "mcp/source/scripts/hwai-utility-mcp-daily-loop.mjs"
  "mcp/source/scripts/hwai-utility-mcp-measurement-report.mjs"
  "mcp/source/scripts/hwai-scraper-plane-accounting-report.mjs"
)
# mcp/manifest.json is handled separately (may be overridden via --manifest).

md5_of() {
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$1"
  else
    md5sum "$1" | awk '{print $1}'
  fi
}

# --- preflight: every source file must exist ---
missing=0
for rel in "${SCRIPTS_CLOSURE[@]}" "${SOURCE_SCRIPTS_CLOSURE[@]}"; do
  if [[ ! -f "$REPO_ROOT/$rel" ]]; then
    echo "ERROR: missing source file: $REPO_ROOT/$rel" >&2
    missing=1
  fi
done
if [[ ! -f "$MANIFEST_SRC" ]]; then
  echo "ERROR: missing manifest: $MANIFEST_SRC" >&2
  missing=1
fi
if [[ "$missing" -ne 0 ]]; then
  echo "Aborting: closure incomplete." >&2
  exit 3
fi

if [[ "$MODE" == "check" ]]; then
  if [[ ! -d "$INSTALL_DIR" ]]; then
    echo "DRIFT: install dir does not exist: $INSTALL_DIR" >&2
    exit 4
  fi
  drift=0
  for rel in "${SCRIPTS_CLOSURE[@]}" "${SOURCE_SCRIPTS_CLOSURE[@]}"; do
    src="$REPO_ROOT/$rel"
    dst="$INSTALL_DIR/$rel"
    if [[ ! -f "$dst" ]]; then
      echo "DRIFT: missing in install: $rel" >&2
      drift=1
      continue
    fi
    if [[ "$(md5_of "$src")" != "$(md5_of "$dst")" ]]; then
      echo "DRIFT: content differs: $rel" >&2
      drift=1
    fi
  done
  dst_manifest="$INSTALL_DIR/mcp/manifest.json"
  if [[ ! -f "$dst_manifest" ]]; then
    echo "DRIFT: missing installed manifest: mcp/manifest.json" >&2
    drift=1
  elif [[ "$(md5_of "$MANIFEST_SRC")" != "$(md5_of "$dst_manifest")" ]]; then
    echo "DRIFT: installed manifest differs from --manifest source" >&2
    drift=1
  fi
  if [[ "$drift" -ne 0 ]]; then
    echo "Result: INSTALL DRIFTED from repo source. Re-run installer." >&2
    exit 4
  fi
  echo "Result: install in sync with repo source closure (md5-identical)."
  exit 0
fi

# --- install (idempotent overwrite) ---
echo "Installing token-efficiency collector closure"
echo "  source repo : $REPO_ROOT"
echo "  install dir : $INSTALL_DIR"
echo "  manifest    : $MANIFEST_SRC"

mkdir -p "$INSTALL_DIR/scripts" "$INSTALL_DIR/mcp/source/scripts"

for rel in "${SCRIPTS_CLOSURE[@]}" "${SOURCE_SCRIPTS_CLOSURE[@]}"; do
  cp -f "$REPO_ROOT/$rel" "$INSTALL_DIR/$rel"
done
cp -f "$MANIFEST_SRC" "$INSTALL_DIR/mcp/manifest.json"

# Executable bits for the entry-point scripts.
chmod +x \
  "$INSTALL_DIR/scripts/greg-dogfood-catchup.sh" \
  "$INSTALL_DIR/scripts/greg-dogfood-daily-note.sh" \
  "$INSTALL_DIR/scripts/token-efficiency-report.sh" \
  "$INSTALL_DIR/scripts/greg-dogfood-measurement-readiness.mjs" \
  "$INSTALL_DIR/scripts/greg-dogfood-weekly-rollup.mjs" \
  "$INSTALL_DIR/scripts/greg-dogfood-review-queue.mjs" \
  "$INSTALL_DIR/scripts/hwai-mcp-coverage-report.mjs" \
  "$INSTALL_DIR/mcp/source/scripts/hwai-utility-mcp-daily-loop.mjs" \
  "$INSTALL_DIR/mcp/source/scripts/hwai-utility-mcp-measurement-report.mjs" \
  "$INSTALL_DIR/mcp/source/scripts/hwai-scraper-plane-accounting-report.mjs" \
  2>/dev/null || true

installed=$(( ${#SCRIPTS_CLOSURE[@]} + ${#SOURCE_SCRIPTS_CLOSURE[@]} + 1 ))
echo "Installed $installed files into $INSTALL_DIR"
echo "Entry point: $INSTALL_DIR/scripts/greg-dogfood-catchup.sh"
echo "Re-run with --check to verify install == repo source."
