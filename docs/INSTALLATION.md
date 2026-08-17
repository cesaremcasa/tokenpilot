# Installation and lifecycle

TokenPilot 0.4.8 supports macOS and Linux with Node.js 22.5 or newer. It runs entirely as the current user and does not install provider CLIs, copy provider credentials, or require root.

## Before installation

Confirm the provider CLIs you intend to use already work normally:

```sh
claude --version
codex --version
grok --version
kimi --version
node --version
```

At least one provider CLI is sufficient. A missing provider does not prevent the other launchers from being installed.

## Clean installation

```sh
git clone https://github.com/cesaremcasa/tokenpilot.git
cd tokenpilot
npm ci --ignore-scripts
npm test
npm run build

# Preview every filesystem change.
node dist/cli.js install --dry-run

# Install user-level runtime, launchers, and optional report skills.
node dist/cli.js install
exec "$SHELL" -l
tokenpilot doctor
```

The repository is not published to npm. The `private` package flag deliberately prevents an accidental registry release; it does not limit use under the MIT License.

## What is installed

- `~/.tokenpilot/bin/tokenpilot`
- provider launchers for `claude`, `codex`, `grok`, and `kimi`
- a private, immutable runtime release under `~/.tokenpilot/run`
- a managed PATH block in the supported shell startup file
- optional provider-specific report skills
- a user LaunchAgent on macOS

Linux does not require a permanent service. Each wrapped session finalizes its own collection state.

The installer inspects each skill destination independently. An absent, unsafe, symlinked, or third-party destination is skipped without blocking the runtime or launchers.

## Verification

```sh
tokenpilot --version
tokenpilot doctor
command -v tokenpilot
command -v claude
command -v codex
command -v grok
command -v kimi
```

`doctor` deliberately separates installation readiness from measurement capability. A provider can be `active`, `limited`, `shadowed`, or `unavailable` while the installation itself remains ready.

## Upgrade

```sh
cd tokenpilot
git pull --ff-only
npm ci --ignore-scripts
npm test
npm run build
node dist/cli.js install
exec "$SHELL" -l
tokenpilot doctor
```

Reinstalling replaces only TokenPilot-owned launchers, runtime files, managed shell blocks, and managed skills. It preserves the local SQLite database and experimental allocator.

For automation, run the build and install under the same login shell that owns the provider CLIs. A non-login SSH shell may resolve an older system Node.js even when the user normally runs Node 22.

## Immediate rollback and bypass

```sh
# One process; no TokenPilot telemetry or treatment.
TOKENPILOT_BYPASS=1 claude

# Future sessions; original provider behavior and no TokenPilot telemetry.
tokenpilot mode off

# Native provider settings while retaining supported numeric measurement.
tokenpilot mode deep
```

## Uninstall

```sh
tokenpilot uninstall --dry-run
tokenpilot uninstall
exec "$SHELL" -l
```

Uninstall removes only TokenPilot-owned launchers, its managed PATH block, installed managed skills, and the macOS LaunchAgent. It preserves the telemetry database for review. TokenPilot never automatically deletes the user's measurements.

## Local state

| Platform | Configuration | Telemetry |
| --- | --- | --- |
| macOS | `~/.config/tokenpilot/config.json` | `~/.local/share/tokenpilot/telemetry.sqlite` |
| Linux | `~/.tokenpilot/config/config.json` | `~/.tokenpilot/data/telemetry.sqlite` |

State directories and files must be owned by the current user, must not be symlinks, and must not be group- or world-writable.

## Windows

Native Windows and PowerShell launchers are not released. WSL is a Linux environment and may work as Linux, but it is not part of the current clean-machine acceptance matrix. Do not advertise native Windows support until the dedicated installer, signal, PATH, SQLite, shell, and rollback suite is complete.
