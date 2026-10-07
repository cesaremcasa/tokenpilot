# Installation

TokenPilot 0.5.6 supports macOS and Linux with zsh or bash with Node.js 22.13.0 or later in the 22.x line, or 23.4.0 and later. npm is required for the npm installation. Native Windows and PowerShell are unsupported.

Install and authenticate at least one provider CLI first. TokenPilot uses that existing CLI and its existing login; it does not install providers or handle their authentication. You do not need all four providers.

```sh
node --version
codex --version # or claude --version, grok --version, or kimi --version
```

## Install the verified release

The verified GitHub release is 0.5.6. The npm registry remains at 0.5.5 until its security-key publication confirmation completes. Use the exact release artifact to obtain the current fixes.

```sh
npm install -g https://github.com/cesaremcasa/tokenpilot/releases/download/v0.5.6/cesaremcasa-tokenpilot-0.5.6.tgz
tokenpilot install
tokenpilot doctor
```

If npm global installation fails with `EACCES`, use a user-owned Node/npm installation or this no-global alternative instead of sudo:

```sh
npm exec --yes --package=https://github.com/cesaremcasa/tokenpilot/releases/download/v0.5.6/cesaremcasa-tokenpilot-0.5.6.tgz -- tokenpilot install
```

The installer copies its runtime into user-owned state, so the npm cache is not required afterward.

Open a new terminal, then confirm that TokenPilot's launchers resolve before the original provider commands:

```sh
command -v tokenpilot
command -v codex # replace with the provider you installed
```

The launchers live in `~/.tokenpilot/bin`. The installer adds that directory to the supported shell startup file. Existing terminals keep their old `PATH` until restarted or reloaded.

## Install from source

Use this option when developing TokenPilot. It still requires an installed and authenticated provider CLI.

```sh
git clone https://github.com/cesaremcasa/tokenpilot.git
cd tokenpilot
npm ci --ignore-scripts
npm run build
node dist/cli.js install
```

Open a new terminal and run `tokenpilot doctor`. During source development, `node dist/cli.js` invokes the checkout directly; provider commands such as `codex` use the installed shims after the shell reload.

## Verify or repair installation

```sh
tokenpilot --version
tokenpilot doctor
tokenpilot report --provider codex # substitute your provider
```

`doctor` reports installation readiness separately from measurement availability. `Measurement: limited` can mean the provider is installed but does not expose a supported correlated usage source. A provider you do not use may be unavailable without affecting the providers you installed.

To update an npm installation, run `npm install -g https://github.com/cesaremcasa/tokenpilot/releases/download/v0.5.6/cesaremcasa-tokenpilot-0.5.6.tgz` and then `tokenpilot install`. The installer refreshes TokenPilot-owned launchers and runtime files and preserves local measurements.

## Bypass and uninstall

Run a provider directly for one session to bypass TokenPilot completely:

```sh
TOKENPILOT_BYPASS=1 codex
```

To remove TokenPilot's launchers and managed shell configuration:

```sh
tokenpilot uninstall --dry-run
tokenpilot uninstall
```

Uninstall preserves the local telemetry database. See [troubleshooting](TROUBLESHOOTING.md) if a command still resolves to an unexpected executable.
