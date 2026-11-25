#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  printf '%s\n' \
    'Usage: ./run-desktop.sh [desktop development options]' \
    'Runs this checkout with the project-local voice development profile.' \
    'Settings and sessions are kept under tmp/build/voice-desktop.'
  exit 0
fi

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v bun >/dev/null 2>&1; then
  export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  printf '%s\n' 'Bun is required. Install it, then run bun install from this repository.' >&2
  exit 1
fi

export OPENCODE_DESKTOP_TEST_ROOT="$PWD/tmp/build/voice-desktop"
export OPENCODE_DESKTOP_REUSE_SERVER=1
export OPENCODE_DESKTOP_REUSE_SERVICE_FILE="$OPENCODE_DESKTOP_TEST_ROOT/state/opencode/service-local.json"
export OPENCODE_DESKTOP_DISABLE_PROTOCOL_REGISTRATION=1
export OPENCODE_FLAGS="${OPENCODE_FLAGS:-voice_calls}"
export OPENCODE_DB="$OPENCODE_DESKTOP_TEST_ROOT/data/opencode.db"
export OPENCODE_CONFIG_DIR="$OPENCODE_DESKTOP_TEST_ROOT/config"
export OPENCODE_TEST_HOME="$OPENCODE_DESKTOP_TEST_ROOT/home"
export TMPDIR="$PWD/packages/desktop/build/voice/tmp"
mkdir -p "$TMPDIR"

exec bun --bun run dev:desktop "$@"
