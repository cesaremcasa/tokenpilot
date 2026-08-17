#!/usr/bin/env bash
# Install a local poller that fast-forwards TokenPilot from origin/main.
# Never touches the local telemetry database or provider credentials.
set -euo pipefail

REPO="${TOKENPILOT_REPO:-${HOME}/.tokenpilot/src}"
SOURCE_URL="${TOKENPILOT_GIT_URL:-https://github.com/cesaremcasa/tokenpilot.git}"
INTERVAL="${TOKENPILOT_UPDATE_INTERVAL:-900}"
LOG_DIR="${HOME}/.tokenpilot/logs"
MARKER="tokenpilot-managed-auto-update"

if [[ -n "${TOKENPILOT_GIT_SSH_KEY:-}" ]]; then
  export GIT_SSH_COMMAND="ssh -i ${TOKENPILOT_GIT_SSH_KEY} -o IdentitiesOnly=yes"
fi

if [[ ! -d "${REPO}/.git" ]]; then
  mkdir -p "$(dirname "${REPO}")"
  git clone --branch main --single-branch "${SOURCE_URL}" "${REPO}"
fi

if [[ ! -x "${REPO}/scripts/update.sh" ]]; then
  echo "scripts/update.sh is missing in ${REPO}. Pull TokenPilot 0.4.12 or newer first." >&2
  exit 1
fi

mkdir -p "${LOG_DIR}"
chmod 700 "${LOG_DIR}" 2>/dev/null || true
touch "${LOG_DIR}/update.log"
chmod 600 "${LOG_DIR}/update.log" 2>/dev/null || true

if [[ "$(uname -s)" == "Darwin" ]]; then
  agents="${HOME}/Library/LaunchAgents"
  plist="${agents}/com.tokenpilot.update.plist"
  mkdir -p "${agents}"
  if [[ -f "${plist}" ]] && ! grep -q "com.tokenpilot.update" "${plist}"; then
    echo "Refusing to overwrite non-TokenPilot LaunchAgent: ${plist}" >&2
    exit 1
  fi
  cat > "${plist}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tokenpilot.update</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${REPO}/scripts/update.sh</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>TOKENPILOT_REPO</key><string>${REPO}</string>
    <key>HOME</key><string>${HOME}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>${INTERVAL}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/update.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/update.log</string>
</dict></plist>
EOF
  chmod 600 "${plist}"
  uid="$(id -u)"
  launchctl bootout "gui/${uid}" "${plist}" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "${plist}"
  echo "Installed macOS poller ${plist} (every ${INTERVAL}s) for ${REPO}."
  exit 0
fi

minutes="$((INTERVAL / 60))"
if [[ "${minutes}" -lt 1 ]]; then
  minutes=15
fi
line="*/${minutes} * * * * TOKENPILOT_REPO=${REPO} ${REPO}/scripts/update.sh >> ${LOG_DIR}/update.log 2>&1 # ${MARKER}"
existing="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "${existing}" | grep -v "${MARKER}" || true)"
if [[ -n "${filtered}" ]]; then
  printf '%s\n%s\n' "${filtered}" "${line}" | crontab -
else
  printf '%s\n' "${line}" | crontab -
fi
echo "Installed Linux cron poller (every ${minutes}m) for ${REPO}."
