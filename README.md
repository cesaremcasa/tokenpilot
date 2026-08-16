# TokenPilot

[![CI](https://github.com/cesaremcasa/tokenpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/cesaremcasa/tokenpilot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22.5+](https://img.shields.io/badge/Node.js-22.5%2B-339933.svg)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](docs/INSTALLATION.md)

TokenPilot is a local-first measurement and optimization layer for the terminal versions of Claude Code, OpenAI Codex, Grok Build, and Kimi Code CLI. Developers keep using the provider commands and provider authentication they already know:

```sh
claude
codex
grok
kimi
```

TokenPilot measures provider-published numeric usage, runs version-gated token-reduction treatments, and produces cache-aware seven-day reports. It does not proxy model traffic, create a shared cache, read credentials, or store prompts, responses, source code, tool output, command arguments, or working directories.

Developed by **Mycellium Lab** and released under the [MIT License](LICENSE).

## First research round

The first controlled round was completed on August 15, 2026, on a Linux test host with TokenPilot 0.4.6. Results are separated by provider and are not summed.

| Provider | Coverage | Validated median token reduction | Cohort token reduction | Median latency change |
| --- | ---: | ---: | ---: | ---: |
| Claude | 45/46 measured | **66.0%** | 66.3% | 35.3% faster |
| Codex | 49/51 measured | **54.8%** | 55.5% | 69.0% faster |
| Grok | 39/40 measured | **42.6%** | 50.8% | 68.4% faster |
| Kimi | 42/46 measured | **51.6%** | 51.5% | 4.2% faster |

These are early, task-specific research cohorts, not universal performance promises. Every validated row met TokenPilot's 5+5 minimum and cache-aware comparison rules. Provider/model coverage, session counts, medians, totals, unavailable sessions, and limitations are documented in [First research round](docs/RESULTS.md). The second weekly snapshot is planned for August 22, 2026.

## What TokenPilot changes

A new installation defaults to `balanced`. For each provider, TokenPilot persistently alternates between an unchanged `observe` session and a versioned `balanced` treatment. This preserves a provider-local baseline while testing a real reduction policy.

| Provider | Current `balanced` treatment | Boundary |
| --- | --- | --- |
| Claude | Low effort, stable cache prefix, latency-first instruction, core repository tools, and no Chrome startup. | Session flags only. Use `deep`, `off`, or the bypass for web, MCP, agents, notebooks, or other excluded tools. |
| Codex | Low reasoning, no reasoning summary, low verbosity, concise execution, and compaction at 32k tokens. | Session-scoped `--config`; prompt telemetry remains disabled. |
| Grok | Low reasoning, verbatim user prompt, and a fixed rule against irrelevant context and tool narration. | No system-prompt override, tool restriction, or API-only cache key. |
| Kimi | For audited 0.36.x text-print sessions, `thinking: off` and core coding tools. | Interactive Kimi remains fail-open and measurement-limited. |

Treatments are enabled only after the installed CLI passes the complete local help/version probe. If a probe, collector, or database operation fails, TokenPilot opens the original provider CLI without the treatment.

## Requirements

- macOS or Linux;
- Node.js 22.5 or newer;
- zsh or bash; and
- at least one supported provider CLI already installed and authenticated.

Windows native support is not yet released. See the current [provider and platform matrix](docs/PROVIDERS.md).

## Quick start

```sh
git clone https://github.com/cesaremcasa/tokenpilot.git
cd tokenpilot
npm ci --ignore-scripts
npm test
npm run build
node dist/cli.js install
exec "$SHELL" -l
tokenpilot doctor
```

The installer creates the `tokenpilot`, `claude`, `codex`, `grok`, and `kimi` launchers under `~/.tokenpilot/bin`. It also installs optional report skills when their destination directories are safe. No root access or second provider login is required.

After installation, continue using the provider normally. TokenPilot records a content-free session envelope and marks it measured only when that exact session publishes correlated numeric counters.

```sh
codex

# Immediate bypass: original provider CLI, no TokenPilot telemetry.
TOKENPILOT_BYPASS=1 codex

# Inspect installation and measurement capability separately.
tokenpilot doctor

# Show the concise rolling seven-day report.
tokenpilot report
```

Read the full [installation and upgrade guide](docs/INSTALLATION.md) before distributing TokenPilot to another machine.

## Report skills

Each provider receives a read-only local report skill. Skills never inspect the SQLite database directly and never combine providers.

| Provider | Command |
| --- | --- |
| Claude Code | `/tokenpilot` |
| OpenAI Codex | `$tokenpilot` or select `tokenpilot` after typing `/` |
| Grok Build | `/tokenpilot` |
| Kimi Code CLI | `/skill:tokenpilot` |

## Controls

```sh
tokenpilot mode balanced  # 50/50 provider-local experiment; installation default
tokenpilot mode observe   # unchanged provider behavior with measurement
tokenpilot mode deep      # native provider settings with measurement
tokenpilot mode off       # original CLI with no TokenPilot telemetry

tokenpilot sessions --unclassified
tokenpilot classify <run-id> --kind research --outcome completed

tokenpilot report --provider claude
tokenpilot report --view detail
tokenpilot report --view diagnostics
```

Authentication and support commands such as login, logout, help, and version pass through without creating telemetry. `TOKENPILOT_BYPASS=1` is the process-level emergency bypass.

## Measurement contract

TokenPilot never calls a cache shift a token reduction. It reports these categories separately:

- new input;
- cache reads;
- cache creation;
- output;
- reasoning;
- token pressure; and
- a complete cache-aware total.

A reduction is validated only for the same provider, known non-benchmark task type, policy, metric basis, and price snapshot, with at least five measured baselines and five measured treatments. If new input moves into cache while the complete total remains effectively flat, the state is `cache-shift` and TokenPilot emits no percentage, avoided tokens, or avoided USD.

See [Measurement methodology](docs/MEASUREMENT.md) for formulas, comparison states, pricing rules, and audit requirements.

## Privacy and security

Raw data stays on the user's machine:

- macOS: `~/.local/share/tokenpilot/telemetry.sqlite`
- Linux: `~/.tokenpilot/data/telemetry.sqlite`

The database stores only content-free session metadata and numeric counters. TokenPilot does not scan provider histories, transcripts, logs, JSONL files, source repositories, or credential stores. Local receivers bind to `127.0.0.1`, use a per-run secret where supported, and are destroyed after the session.

Read [Security](SECURITY.md), [Architecture](docs/ARCHITECTURE.md), and [Measurement methodology](docs/MEASUREMENT.md) before changing an adapter.

## Documentation

- [Installation, upgrade, rollback, and uninstall](docs/INSTALLATION.md)
- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Measurement methodology](docs/MEASUREMENT.md)
- [Provider and model compatibility](docs/PROVIDERS.md)
- [First research round](docs/RESULTS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Enterprise adoption](docs/ENTERPRISE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Project status

TokenPilot is active research software. The measured reductions above are promising, but provider CLIs and telemetry surfaces can change. Unsupported or uncorrelated sessions are reported as unavailable rather than estimated. Use the bypass controls whenever a task requires the provider's full native behavior.

The npm package remains marked `private` to prevent accidental registry publication. This does not restrict source use: the repository is licensed under MIT.

## License

Copyright © 2026 Mycellium Lab. TokenPilot is available under the [MIT License](LICENSE).
