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

MACHINE_ARCH="$(uname -m 2>/dev/null || true)"
case "$MACHINE_ARCH" in
  x86_64|amd64) SERVER_EXE="$SCRIPT_DIR/bin/VisualWaveDrom-server-linux-amd64" ;;
  *)
    echo "[ERROR] Unsupported Linux architecture: ${MACHINE_ARCH:-unknown}"
    echo "This package currently contains the Linux x64 static server."
    exit 1
    ;;
esac

if [[ ! -f "$SERVER_EXE" ]]; then
  echo "[ERROR] VisualWaveDrom static server was not found:"
  echo "$SERVER_EXE"
  echo "Restore the bin folder from the VisualWaveDrom package."
  exit 1
fi
if [[ ! -x "$SERVER_EXE" ]]; then
  chmod +x "$SERVER_EXE" 2>/dev/null || {
    echo "[ERROR] The static server is not executable: $SERVER_EXE"
    exit 1
  }
fi
if [[ ! -f "$SCRIPT_DIR/$HTML_FILE_NAME" ]]; then
  echo "[ERROR] HTML file was not found: $SCRIPT_DIR/$HTML_FILE_NAME"
  exit 1
fi

if [[ "${1:-}" == "--check-runtime" ]]; then
  exec "$SERVER_EXE" \
    --root "$SCRIPT_DIR" \
    --html "$HTML_FILE_NAME" \
    --library "$WAVE_LIBRARY_PATH" \
    --check-runtime
fi

if (( $# > 0 )) && [[ "$1" != --* ]]; then
  OPEN_URL="$1"
  shift
  set -- --open-url "$OPEN_URL" "$@"
fi
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  HAS_NO_OPEN=0
  for argument in "$@"; do
    [[ "$argument" == "--no-open" ]] && HAS_NO_OPEN=1
  done
  if (( HAS_NO_OPEN == 0 )); then
    set -- --no-open "$@"
  fi
fi

cd -- "$SCRIPT_DIR" || exit 1
exec "$SERVER_EXE" \
  --root "$SCRIPT_DIR" \
  --html "$HTML_FILE_NAME" \
  --library "$WAVE_LIBRARY_PATH" \
  --protocol-handler "$SCRIPT_PATH" \
  "$@"
