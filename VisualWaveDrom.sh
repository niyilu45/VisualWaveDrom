#!/usr/bin/env bash
set -uo pipefail

# ===== PROJECT SETTINGS - CHANGE THESE VALUES ONLY =====
HTML_FILE_NAME="VisualWaveDrom.html"
WAVE_LIBRARY_RELATIVE_PATH="Wave/VisualWaveDrom-library/library.sqlite"
# ======================================================

SOURCE_PATH="${BASH_SOURCE[0]}"
while [[ -h "$SOURCE_PATH" ]] && command -v readlink >/dev/null 2>&1; do
  SOURCE_PARENT="${SOURCE_PATH%/*}"
  [[ "$SOURCE_PARENT" == "$SOURCE_PATH" ]] && SOURCE_PARENT='.'
  [[ -z "$SOURCE_PARENT" ]] && SOURCE_PARENT='/'
  SOURCE_DIR="$(cd -P -- "$SOURCE_PARENT" >/dev/null 2>&1 && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  [[ "$SOURCE_PATH" != /* ]] && SOURCE_PATH="$SOURCE_DIR/$SOURCE_PATH"
done
SOURCE_PARENT="${SOURCE_PATH%/*}"
[[ "$SOURCE_PARENT" == "$SOURCE_PATH" ]] && SOURCE_PARENT='.'
[[ -z "$SOURCE_PARENT" ]] && SOURCE_PARENT='/'
SCRIPT_DIR="$(cd -P -- "$SOURCE_PARENT" >/dev/null 2>&1 && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/${SOURCE_PATH##*/}"

if [[ "$WAVE_LIBRARY_RELATIVE_PATH" = /* ]]; then
  WAVE_LIBRARY_PATH="$WAVE_LIBRARY_RELATIVE_PATH"
else
  WAVE_LIBRARY_PATH="$SCRIPT_DIR/$WAVE_LIBRARY_RELATIVE_PATH"
fi

find_node() {
  local candidate=""
  if [[ -n "${VWD_NODE_EXE:-}" ]]; then
    candidate="$VWD_NODE_EXE"
  elif [[ -x "$SCRIPT_DIR/inc/node-runtime/bin/node" ]]; then
    candidate="$SCRIPT_DIR/inc/node-runtime/bin/node"
  elif [[ -x "$SCRIPT_DIR/inc/node-runtime/node" ]]; then
    candidate="$SCRIPT_DIR/inc/node-runtime/node"
  elif command -v node >/dev/null 2>&1; then
    candidate="$(command -v node)"
  elif command -v nodejs >/dev/null 2>&1; then
    candidate="$(command -v nodejs)"
  fi
  printf '%s' "$candidate"
}

find_sqlite() {
  local candidate=""
  if [[ -n "${VWD_SQLITE_EXE:-}" ]]; then
    candidate="$VWD_SQLITE_EXE"
  elif [[ -x "$SCRIPT_DIR/inc/sqlite/sqlite3" ]]; then
    candidate="$SCRIPT_DIR/inc/sqlite/sqlite3"
  elif command -v sqlite3 >/dev/null 2>&1; then
    candidate="$(command -v sqlite3)"
  fi
  printf '%s' "$candidate"
}

NODE_EXE="$(find_node)"
if [[ -z "$NODE_EXE" ]] || ! "$NODE_EXE" --version >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found."
  echo "Install Node.js 18 or newer, or set VWD_NODE_EXE to the Node.js executable."
  echo "Debian/Ubuntu: sudo apt install nodejs"
  echo "Fedora/RHEL:   sudo dnf install nodejs"
  echo "Arch Linux:    sudo pacman -S nodejs"
  exit 1
fi

NODE_MAJOR="$("$NODE_EXE" -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 18 )); then
  echo "[ERROR] Node.js 18 or newer is required. Current version: $("$NODE_EXE" --version 2>&1)"
  exit 1
fi

SQLITE_EXE="$(find_sqlite)"
if [[ -z "$SQLITE_EXE" ]] || ! "$SQLITE_EXE" --version >/dev/null 2>&1; then
  echo "[ERROR] SQLite was not found."
  echo "Install SQLite 3.33 or newer, or set VWD_SQLITE_EXE to the sqlite3 executable."
  echo "Debian/Ubuntu: sudo apt install sqlite3"
  echo "Fedora/RHEL:   sudo dnf install sqlite"
  echo "Arch Linux:    sudo pacman -S sqlite"
  exit 1
fi

SQLITE_PROBE="$(printf '.bail on\n.mode json\nSELECT 1 AS ok;\n' \
  | "$SQLITE_EXE" -batch :memory: 2>&1)"
SQLITE_PROBE_COMPACT="${SQLITE_PROBE//$' '/}"
SQLITE_PROBE_COMPACT="${SQLITE_PROBE_COMPACT//$'\t'/}"
SQLITE_PROBE_COMPACT="${SQLITE_PROBE_COMPACT//$'\r'/}"
SQLITE_PROBE_COMPACT="${SQLITE_PROBE_COMPACT//$'\n'/}"
if [[ "$SQLITE_PROBE_COMPACT" != *'"ok":1'* ]]; then
  echo "[ERROR] SQLite 3.33 or newer with JSON output support is required."
  echo "$SQLITE_PROBE"
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/VisualWaveDrom.js" ]]; then
  echo "[ERROR] VisualWaveDrom.js was not found in $SCRIPT_DIR"
  exit 1
fi
if [[ ! -f "$SCRIPT_DIR/$HTML_FILE_NAME" ]]; then
  echo "[ERROR] HTML file was not found: $SCRIPT_DIR/$HTML_FILE_NAME"
  exit 1
fi

export VWD_SQLITE_EXE="$SQLITE_EXE"

if [[ "${1:-}" == "--check-runtime" ]]; then
  SQLITE_VERSION="$("$SQLITE_EXE" --version)"
  SQLITE_VERSION="${SQLITE_VERSION%% *}"
  PLATFORM_INFO="$("$NODE_EXE" -p "process.platform + ' ' + process.arch")"
  echo "Platform:       $PLATFORM_INFO"
  echo "Node.js:        $NODE_EXE ($("$NODE_EXE" --version))"
  echo "SQLite:         $SQLITE_EXE ($SQLITE_VERSION)"
  echo "HTML:           $SCRIPT_DIR/$HTML_FILE_NAME"
  echo "Wave library:   $WAVE_LIBRARY_PATH"
  exit 0
fi

LAUNCH_ARGS=()
if (( $# > 0 )) && [[ "$1" != --* ]]; then
  LAUNCH_ARGS+=(--open-url "$1")
  shift
fi
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  HAS_NO_OPEN=0
  for argument in "$@"; do
    [[ "$argument" == "--no-open" ]] && HAS_NO_OPEN=1
  done
  (( HAS_NO_OPEN == 0 )) && LAUNCH_ARGS+=(--no-open)
fi

cd -- "$SCRIPT_DIR" || exit 1
exec "$NODE_EXE" "$SCRIPT_DIR/VisualWaveDrom.js" \
  --html "$HTML_FILE_NAME" \
  --library "$WAVE_LIBRARY_PATH" \
  --protocol-handler "$SCRIPT_PATH" \
  "${LAUNCH_ARGS[@]}" \
  "$@"
