# TokenPilot

[![CI](https://github.com/cesaremcasa/tokenpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/cesaremcasa/tokenpilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40cesaremcasa%2Ftokenpilot.svg)](https://www.npmjs.com/package/@cesaremcasa/tokenpilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 22.13+ or 23.4+](https://img.shields.io/badge/Node.js-22.13%2B_or_23.4%2B-339933.svg)](https://nodejs.org/)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/INSTALLATION.md)

Local token measurement and efficiency treatments for AI coding command-line tools. TokenPilot wraps provider CLIs already installed on your machine; it does not proxy traffic or store prompts, responses, source code, or credentials.

## Install and run

Install the published 0.5.6 package from npm:

Requires macOS or Linux with zsh or bash, Node.js 22.13.0+ in the 22.x line or 23.4.0 and later, npm, and at least one supported provider CLI already installed and authenticated. You do not need all four providers. Native Windows and PowerShell are not supported.

```sh
npm install -g @cesaremcasa/tokenpilot@0.5.6
tokenpilot install
tokenpilot doctor
```

Open a new terminal after installation so the launchers are first on `PATH`.

```sh
codex --model gpt-5.5
tokenpilot report --provider codex

# Run the original provider directly, without TokenPilot measurement or treatment.
TOKENPILOT_BYPASS=1 codex
```

See [installation, upgrades, and removal](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/INSTALLATION.md) and [troubleshooting](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/TROUBLESHOOTING.md).

## What it does

TokenPilot reports provider-published numeric usage and applies version-gated treatments where supported. If a capability is missing or setup fails, it starts the original CLI unchanged. A missing provider does not block the others. Claude Code, Codex, and Grok Build have supported measurement or treatment paths; Kimi Code CLI currently passes through without treatment or reduction claims.

The default report shows current-session cache reuse and uncached input, for example `Cache reuse: X% · Uncached input: Y%`. These percentages describe that session's input counters; they do not measure total-token savings or prove that TokenPilot caused a reduction. See the [measurement methodology](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/MEASUREMENT.md).

### What the default `reduce` mode changes

`reduce` is the default mode. When the installed provider CLI advertises the required options, TokenPilot adds session-scoped arguments to that launch only. Otherwise the launch runs without a treatment.

| Provider | Arguments added in `reduce` (see [`src/optimization.ts`](https://github.com/cesaremcasa/tokenpilot/blob/main/src/optimization.ts)) |
| --- | --- |
| Claude Code | `--effort low` and `--append-system-prompt` with a fixed token-efficiency instruction |
| Codex | Only when the launch has an explicit `--model`. Always `model_reasoning_effort="low"` and fixed `developer_instructions`. Catalogued models also get a 2,000-token skills budget and either 16k auto-compaction or, for `gpt-5.5`, `model_verbosity="low"`, no reasoning summary and Code Mode on Codex 0.160.1. Other models get low verbosity, no reasoning summary and 32k auto-compaction |
| Grok Build | Low reasoning effort, `--verbatim` and `--rules` with a fixed token-efficiency instruction |
| Kimi Code CLI | Nothing; runs unchanged |

Lower reasoning effort, lower verbosity and earlier compaction can change answer quality and behaviour. Use `observe` if you want measurement without these changes.

| Mode | Behaviour |
| --- | --- |
| `reduce` (default) | Measure and apply the treatment above |
| `observe` | Measure only; no arguments are added |
| `balanced` | Measure and alternate per provider between `observe` and the `reduce` treatment (first choice random), for local A/B comparison |
| `deep` | Measure only; currently adds no arguments, like `observe`, but is not used as a comparison baseline |
| `off` | No measurement and no treatment |

Switch with `tokenpilot mode <reduce|observe|balanced|deep|off>`.

The capture below shows actual version/help stdout in a browser viewer; it is not a token-savings measurement.

![Actual CLI version and help output capture](https://raw.githubusercontent.com/cesaremcasa/tokenpilot/main/docs/assets/cli-smoke.png)

## Measured task results

On October 6, 2026, one paired observe/reduce task was recorded for each listed model. The measured change in total input plus output was at least 42% for 6 of 9 OpenAI models and 4 of 4 Grok models. These are individual controlled-task observations, not universal estimates; one pair per model gives no statistical equivalence guarantee. Claude, Kimi, and Grok Bot results are unproven.

Limitations of this evidence:

- Each model has a single observe/reduce pair, and every pair used the same public maintenance task (one flag-order fix from one baseline commit).
- The Codex and Grok policies used on October 6 were revised after the [October 5 runs](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/EVALUATION-2026-10-05.md) on that same task. Several Codex models use model-specific variants, and prompt revisions differ between recorded runs.
- How much of each reduction comes from the lower reasoning effort, as opposed to the other arguments, was not isolated.
- The 42% line is a project target used to summarise results. It is a heuristic, not a statistically derived threshold.

| Provider and tested models | Pairs at or above 42% | Observed range |
| --- | ---: | ---: |
| OpenAI Codex (9 models) | 6/9 | 19.8%–62.2% |
| Grok Build (4 models) | 4/4 | 57.1%–76.5% |

The paired-task metric includes cached input and output. It is separate from the per-session cache percentages above. See the [OpenAI evidence](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/evidence/2026-10-06/openai-reductions.json) and [Grok evidence](https://github.com/cesaremcasa/tokenpilot/blob/main/docs/evidence/2026-10-06/grok-reductions.json).

![Measured task reductions](https://raw.githubusercontent.com/cesaremcasa/tokenpilot/main/docs/assets/measured-reductions.svg)

## Platform and privacy

| Platform | Status |
| --- | --- |
| macOS, Node.js 22.13.0+ or 23.4.0+ | Supported |
| Linux, Node.js 22.13.0+ or 23.4.0+ | Supported |
| Native Windows / PowerShell | Unsupported |

Telemetry is stored locally as content-free session metadata and numeric counters. Provider histories, transcripts, logs, repositories, and credential stores are not scanned. `TOKENPILOT_BYPASS=1 <provider>` immediately invokes the provider without TokenPilot; `tokenpilot mode off` disables future measurement and treatment. Read the [security policy](https://github.com/cesaremcasa/tokenpilot/blob/main/SECURITY.md) for details.

TokenPilot is released under the [MIT License](https://github.com/cesaremcasa/tokenpilot/blob/main/LICENSE) by Cesar Augusto / Mycellium Lab and is not affiliated with Anthropic, OpenAI, xAI, or Moonshot AI.
