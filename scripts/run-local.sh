#!/usr/bin/env bash
# Starts TapBack locally: whisper.cpp server (optional), backend and plugin dev server.
# Ctrl-C stops everything this script started.
#
#   TAPBACK_ENV=path/to/tapback.env  env file with TG_API_ID / TG_API_HASH (default: ./tapback.env)
#   WHISPER_SERVER=path/to/whisper-server   WHISPER_MODEL=path/to/ggml-base.en.bin   (both optional)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
export TAPBACK_ENV="${TAPBACK_ENV:-$ROOT/tapback.env}"

if [[ ! -f "$TAPBACK_ENV" ]]; then
  echo "No env file at $TAPBACK_ENV. Create it with TG_API_ID and TG_API_HASH (see README)." >&2
  exit 1
fi

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

if [[ ! -d backend/.venv ]]; then
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install -q -r backend/requirements.txt
fi
if [[ ! -d plugin/node_modules ]]; then
  (cd plugin && npm ci --silent)
fi

if [[ -n "${WHISPER_SERVER:-}" && -n "${WHISPER_MODEL:-}" ]]; then
  "$WHISPER_SERVER" -m "$WHISPER_MODEL" --host 127.0.0.1 --port 8080 -nt >/dev/null 2>&1 &
  pids+=($!)
  echo "whisper-server on http://127.0.0.1:8080"
else
  echo "Dictation off: set WHISPER_SERVER and WHISPER_MODEL to enable it."
fi

(cd plugin && npm run dev -- --clearScreen false >/dev/null 2>&1) &
pids+=($!)
echo "plugin on http://localhost:5173 (point the Even Hub simulator or the Even app at it)"

if ! backend/.venv/bin/python -c "
import sys; sys.path.insert(0, 'backend')
from tapback import config; c = config.load(); sys.exit(0 if c.session_file.exists() else 1)"; then
  echo "Not logged in yet. Running the one-time login (phone, code, 2FA are typed here):"
  (cd backend && .venv/bin/python -m tapback login)
fi

cd backend
PYTHONUNBUFFERED=1 .venv/bin/python -m tapback serve
