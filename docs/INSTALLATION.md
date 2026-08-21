# Installation and lifecycle

TokenPilot 0.5.0 public beta supports macOS and Linux with Node.js 22.5 or newer. Node 22 is the clean-machine acceptance runtime. TokenPilot runs entirely as the current user and does not install provider CLIs, copy provider credentials, or require root.

If you opened this repository to use Grok: install **Grok Build** first. TokenPilot only wraps it.

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
grok --version
grok login
```

`tokenpilot doctor` prints `grok CLI unavailable` until that original binary exists outside TokenPilot's shim directory. That warning means Grok is missing, not that TokenPilot is broken.

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

## npm installation

```sh
npm install -g tokenpilot
tokenpilot install --dry-run
tokenpilot install
tokenpilot doctor
```

Open a new terminal before starting a provider session so `~/.tokenpilot/bin` is active on `PATH`.

## Source installation

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

## Verified release artifact

For a reviewed tarball rather than a checkout, generate and verify the release artifacts before installation:

```sh
npm ci --ignore-scripts
npm run build
npm run release:artifact -- --output release-artifacts
shasum -a 256 -c release-artifacts/tokenpilot-0.5.0.tgz.sha256
```

The generated CycloneDX file is derived from `package-lock.json`. The release script packs the tarball twice and refuses to continue if the bytes differ. The tarball smoke installs that exact file into a temporary npm consumer, executes the staged private runtime after removing the consumer copy, and uninstalls the temporary launchers. It does not use the source checkout as the runtime artifact.

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

## Upgrade an npm installation

```sh
npm install -g tokenpilot@latest
tokenpilot install
tokenpilot doctor
```

The second `tokenpilot install` stages the new private runtime and refreshes only TokenPilot-owned launchers, shell blocks, and skills. Configuration, the experiment allocator, and local telemetry remain in their existing state directories.

## Upgrade a source installation

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

```sh
./scripts/update.sh
```

`scripts/update.sh` is the same sequence: fast-forward `main`, install dependencies, test (unless `TOKENPILOT_UPDATE_SKIP_TESTS=1`), build, and reinstall. It refuses a dirty checkout and never reads or writes telemetry or provider credentials.

## Automatic updates

Each machine keeps its own SQLite database. An update never copies measurements between hosts.

Source installations may install a local poller that pulls `origin/main` on a timer. npm installations should upgrade with `npm install -g tokenpilot@latest` instead.

```sh
./scripts/update.sh
./scripts/install-auto-update.sh
```

On macOS this writes `~/Library/LaunchAgents/com.tokenpilot.update.plist`. On Linux it adds one marked user crontab line and leaves every other cron job untouched. The default checkout is `~/.tokenpilot/src` cloned over HTTPS (`https://github.com/cesaremcasa/tokenpilot.git`; override with `TOKENPILOT_GIT_URL`), so a dirty development clone is never rewritten. Override the checkout path with `TOKENPILOT_REPO`. If git fetch needs a deploy key, set `TOKENPILOT_GIT_SSH_KEY` to that private-key path. The poller only rebuilds when `origin/main` moved. `update.sh` refuses to run unless the checkout is already on `main`.

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
