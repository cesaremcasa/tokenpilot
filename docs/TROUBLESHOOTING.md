# Troubleshooting

Start with the installation and diagnostic summary:

```sh
tokenpilot --version
tokenpilot doctor
tokenpilot report --view diagnostics
```

## A provider command skips TokenPilot

Check which executables your current shell finds:

```sh
command -v tokenpilot
command -v codex # substitute your provider command
```

The TokenPilot launcher should resolve from `~/.tokenpilot/bin`. If it does not, reinstall and open a new terminal so the managed PATH update takes effect:

```sh
tokenpilot install
exec "$SHELL" -l
tokenpilot doctor
```

Do not copy launchers by hand. If the provider command still resolves elsewhere, inspect your shell startup files for PATH entries that appear after TokenPilot's managed block.

## The original provider CLI is missing

TokenPilot wraps provider programs already installed and authenticated for the same OS user. Install and sign in to the provider using its own instructions, then run `tokenpilot install` and `tokenpilot doctor` again. Only the providers you plan to use are required.

## Node.js is unsupported

TokenPilot requires Node.js 22.13.0+ in the 22.x line, or 23.4.0 and later. A shell opened through SSH or automation may find a different Node version than your interactive terminal:

```sh
node --version
command -v node
bash -ilc 'node --version; tokenpilot --version; tokenpilot doctor'
```

Configure the supported Node.js version in the environment that starts TokenPilot, then reinstall if `doctor` requests it.

## Measurement is limited or a session is unavailable

`Installation: ready` can coexist with limited measurement. The provider may not expose a supported numeric usage source, or the session may lack complete correlated counters. `Unavailable` does not mean zero usage or zero reduction. Kimi currently runs without a TokenPilot treatment or reduction claim; Claude, Codex, and Grok capabilities depend on their CLI version and measurement mode.

The default report's `Cache reuse` and `Uncached input` percentages describe current-session input counters. They do not show total-token reduction or prove that TokenPilot caused a change. Paired-task reduction results are separate observations; see the [measurement methodology](MEASUREMENT.md).

## Bypass TokenPilot

For one session, invoke the provider with the bypass variable:

```sh
TOKENPILOT_BYPASS=1 codex
```

This runs the original provider without TokenPilot treatment or measurement. `tokenpilot mode off` disables TokenPilot measurement and treatment for future sessions until the mode changes.

## Reinstall safely

If `doctor` reports an installation problem, preview and then apply a repair:

```sh
tokenpilot install --dry-run
tokenpilot install
```

The installer refuses to overwrite foreign launchers, modified managed shell blocks, unsafe directories, or third-party skills. Reinstallation preserves the local telemetry database.
