#!/usr/bin/env bash
# Installs the local Faster-Whisper stack into .venv-whisper (no API key, no
# paid service). Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-whisper"
PYTHON="${PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3 is required for local transcription but '$PYTHON' was not found." >&2
  echo "Install python3 (3.9+) and run this again, or point PYTHON at an interpreter." >&2
  exit 1
fi

echo "creating $VENV with $("$PYTHON" --version 2>&1)"
"$PYTHON" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet faster-whisper

"$VENV/bin/python" - <<'PY'
import faster_whisper, numpy, ctranslate2
print(f"faster-whisper {faster_whisper.__version__}, ctranslate2 {ctranslate2.__version__}, numpy {numpy.__version__}")
PY

echo
echo "Ready. Models download once on first use (tiny ≈75 MB, base ≈145 MB) and are cached in .whisper-models/."
echo "Override with WHISPER_MODEL, WHISPER_DEVICE (cpu|cuda), WHISPER_COMPUTE_TYPE and WHISPER_MODEL_DIR."
