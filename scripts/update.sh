#!/usr/bin/env bash
# Fast-forward this checkout from origin/main and reinstall TokenPilot.
# Never reads, copies, or writes the local telemetry database or provider credentials.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${TOKENPILOT_REPO:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
LOCK_DIR="${TMPDIR:-/tmp}/tokenpilot-update.lock"

cd "${REPO}"

if [[ ! -d .git ]]; then
  echo "TokenPilot update: ${REPO} is not a git checkout." >&2
  exit 1
fi

if [[ -d "${LOCK_DIR}" ]]; then
  if find "${LOCK_DIR}" -prune -mmin +30 | grep -q .; then
    rmdir "${LOCK_DIR}" 2>/dev/null || true
  fi
fi
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "TokenPilot update already running."
  exit 0
fi
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

load_node() {
  export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${PATH}"
  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    . "${HOME}/.nvm/nvm.sh"
    nvm use 22 >/dev/null 2>&1 || true
  fi
  local nvm_bin
  nvm_bin="$(ls -d "${HOME}/.nvm/versions/node"/v22.*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "${nvm_bin}" ]]; then
    export PATH="${nvm_bin}:${PATH}"
  fi
  local bundled
  bundled="$(ls -d "${HOME}/.local/opt"/node-v22*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [[ -n "${bundled}" ]]; then
    export PATH="${bundled}:${PATH}"
  fi
}

node_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)'
}

load_node
if ! node_supported; then
  echo "TokenPilot update: Node.js 22.5 or newer is required (found $(command -v node >/dev/null && node --version || echo none))." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "TokenPilot update: refusing to touch a dirty checkout at ${REPO}." >&2
  exit 1
fi

if [[ -n "${TOKENPILOT_GIT_SSH_KEY:-}" ]]; then
  export GIT_SSH_COMMAND="ssh -i ${TOKENPILOT_GIT_SSH_KEY} -o IdentitiesOnly=yes"
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${current_branch}" != "main" ]]; then
  echo "TokenPilot update: refusing to run on branch ${current_branch} (expected main)." >&2
  exit 1
fi

git fetch origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [[ "${local_sha}" == "${remote_sha}" ]]; then
  echo "TokenPilot already at origin/main (${local_sha})."
  exit 0
fi

git pull --ff-only origin main

npm ci --ignore-scripts
if [[ "${TOKENPILOT_UPDATE_SKIP_TESTS:-}" != "1" ]]; then
  npm test
fi
npm run build
node dist/cli.js install

echo "TokenPilot updated to $(node dist/cli.js --version) at $(git rev-parse --short HEAD)."
