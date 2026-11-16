#!/bin/zsh
# Study-OS 1-Click macOS Terminal Launcher
set -u

STUDY_ROOT="${0:A:h}"
cd "$STUDY_ROOT" || exit 1

PYTHON_BIN=""
for candidate in \
  "/opt/anaconda3/bin/python3" \
  "/opt/homebrew/bin/python3" \
  "/usr/local/bin/python3" \
  "/usr/bin/python3" \
  "$(command -v python3 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  fi
done

if [[ -z "$PYTHON_BIN" ]]; then
  echo "Error: Python 3.9+ is required to run Study-OS."
  exit 1
fi

echo "Starting Study-OS from: $STUDY_ROOT"
echo "Using Python: $PYTHON_BIN"
exec "$PYTHON_BIN" "$STUDY_ROOT/app/server.py" --open "$@"
