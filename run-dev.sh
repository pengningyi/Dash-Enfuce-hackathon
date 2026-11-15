#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"

INSTALL_DEPS=false
ENV_NAME=""

usage() {
  cat <<'USAGE'
Usage: ./run-dev.sh [options]

Options:
  -I, --install-dependencies       Install backend/frontend dependencies first
  -E, --environment <env_name>     Create/use a Python virtual environment for backend
  -h, --help                       Show this help message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -I|--install-dependencies)
      INSTALL_DEPS=true
      shift
      ;;
    -E|--environment)
      if [[ $# -lt 2 ]]; then
        echo "Error: --environment requires a value"
        usage
        exit 1
      fi
      ENV_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown option '$1'"
      usage
      exit 1
      ;;
  esac
done

if [[ ! -d "$BACKEND_DIR" || ! -d "$FRONTEND_DIR" ]]; then
  echo "Error: backend/ and frontend/ directories must exist next to this script"
  exit 1
fi

PYTHON_CMD="python3"
PIP_CMD="pip3"

if [[ -n "$ENV_NAME" ]]; then
  if [[ "$ENV_NAME" = /* ]]; then
    ENV_PATH="$ENV_NAME"
  else
    ENV_PATH="$ROOT_DIR/$ENV_NAME"
  fi

  if [[ ! -d "$ENV_PATH" ]]; then
    echo "Creating virtual environment at $ENV_PATH"
    python3 -m venv "$ENV_PATH"
  fi

  PYTHON_CMD="$ENV_PATH/bin/python"
  PIP_CMD="$ENV_PATH/bin/pip"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is not installed or not on PATH"
  exit 1
fi

if $INSTALL_DEPS; then
  echo "Installing backend requirements"
  (cd "$BACKEND_DIR" && "$PIP_CMD" install -r requirements.txt)

  echo "Installing frontend packages"
  (cd "$FRONTEND_DIR" && npm install)
fi

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

echo "Starting backend on http://localhost:8000"
(cd "$BACKEND_DIR" && "$PYTHON_CMD" -m uvicorn app.main:app --reload --port 8000) &
BACKEND_PID=$!

echo "Starting frontend dev server"
(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

set +e
wait -n "$BACKEND_PID" "$FRONTEND_PID"
EXIT_CODE=$?
set -e

exit "$EXIT_CODE"
