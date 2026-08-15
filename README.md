# TokenPilot

TokenPilot is a private, local-first research tool for observing token use in the terminal versions of Claude, Codex, Grok, and Kimi. It preserves the developer workflow: after one installation, use the original commands and log in only with the original provider.

```sh
claude
codex
grok
kimi
```

It does **not** create a shared cache, proxy model traffic, receive provider credentials, or persist prompts, replies, code, tool output, command arguments, or working directories. Provider caches remain provider-side.

## Current scope: personal measurement and reduction

Version 0.3 is a local macOS/Linux tool. A new install defaults to `balanced`: it persistently alternates provider-local `observe` and `balanced` assignments, starting randomly, so there is still a matched baseline. `deep`, `off`, `observe`, and `TOKENPILOT_BYPASS=1` are immediate controls. The wrapper changes a provider session only after that exact installed CLI advertises the required documented flag; any failed probe starts the original CLI unchanged. Windows native support remains unavailable until its separate clean-machine acceptance suite is complete.

Claude and current Codex CLIs can publish local, authenticated metrics through a per-run receiver. Older Codex CLIs fall back only to their published `exec` total. Grok is measured only in explicit one-turn JSON mode; normal Grok TTY sessions are correctly unavailable for token comparison. Kimi remains a session envelope: it does not claim token measurement or savings until documented correlation exists. TokenPilot never scans ambient provider folders, transcripts, or logs.

`balanced` is a durable 50/50 provider-local experimental assignment and a real token-reduction treatment. Its first assignment per provider is random; later sessions alternate between `observe` and `balanced`, even across terminal restarts. Task type is intentionally classified only after a session, so it never influences launch-time assignment. Before every treated session, TokenPilot asks only the installed provider CLI for `--help`. It injects a policy only if that exact local version advertises the required flag. A failed probe or missing capability starts the original CLI unchanged.

| Provider | `balanced` policy | Safety boundary |
| --- | --- | --- |
| Claude | Excludes dynamic system-prompt sections and sets medium effort. | Session arguments only; native tools, MCP, and provider config are not edited. |
| Codex | Sets medium reasoning effort, low verbosity, and automatic compaction at 64k tokens. | Session `--config` overrides only; prompt OTEL export remains disabled. |
| Grok | Sets medium reasoning effort. | Does not use API-only cache keys. |
| Kimi | Disables thinking and bounds steps/retries only when the local CLI exposes all three session flags. | Current Kimi 0.29.x is observed unchanged because it does not advertise those flags. |

The wrapper prints a one-line notice when a treatment is active. It never stores the injected arguments; reports retain only the TokenPilot policy name.

## Requirements

- macOS or Linux and Node.js 22.5 or newer (Windows native is not supported)
- At least one provider CLI already installed and working: `claude`, `codex`, `grok`, or `kimi`
- zsh or bash for automatic integrated-terminal `PATH` setup

## Install from this repository

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js install
exec "$SHELL" -l
tokenpilot doctor
```

The installer creates the `tokenpilot` command and per-provider shims at `~/.tokenpilot/bin`, then places its exact managed PATH block at the end of `~/.zshrc` or, for Bash, both `~/.bashrc` and the existing login startup file (`.bash_profile`, `.bash_login`, or `.profile`). This gives shims precedence even when a login profile appends `~/.local/bin` after sourcing `.bashrc`; a modified managed block is never overwritten. On macOS it also starts a user-only LaunchAgent; on Linux each finished wrapped session finalizes its own collection state, so no system service or root access is required. It copies the compiled runtime into private TokenPilot state, so installed commands keep working if the cloned checkout is moved or deleted.

The report skills are optional integrations. Each destination is inspected independently: an unsafe directory, symlink, or third-party skill is ignored without blocking provider wrappers. `install` prints the resulting state and `tokenpilot doctor` explains the correction. The same versioned skill is installed per user, not per repository or company account:

| Provider | Open the seven-day report |
| --- | --- |
| Claude Code | `/tokenpilot` |
| Codex | `$tokenpilot` (or select it after typing `/`) |
| Kimi Code CLI | `/skill:tokenpilot` |
| Grok | `tokenpilot report` in the terminal until its CLI exposes a documented skill extension |

The installed skill calls its user-owned TokenPilot executable directly rather than relying on `PATH`; it therefore works in Codex and other GUI skill runners that do not load an interactive shell. Its report command defaults to the latest seven days and is read-only: before the first personal session it returns an empty report without creating a database or directory. A legacy WAL database is deliberately not opened by the report because SQLite would create sidecar files; start one personal session once to migrate it. The skill never reads transcripts, prompts, provider logs, project files, environment variables, or the SQLite database directly. Use `tokenpilot install --no-skills` only when a managed environment must distribute the skill separately.

After installation, typing `claude`, `codex`, `grok`, or `kimi` records a content-free local session automatically and applies the selected mode. No terminal environment flag or extra login is required. Use this personal deployment only with the accounts and data that belong in its local experiment; a company rollout must use its own approved deployment and storage.

Preview its changes without writing anything:

```sh
node dist/cli.js install --dry-run
```

The installed CLI deliberately ignores `HOME` and `TOKENPILOT_*` state-directory overrides. Its persistent state is fixed below the OS account home directory, so an untrusted environment cannot redirect installation, uninstallation, or telemetry. The test suite uses an internal, test-only path override to stay isolated.

## Daily use and controls

Normal use is unchanged:

```sh
codex
```

The normal provider command is automatically measured after installation. `login`, `logout`, help, and version commands remain transparent and never create a session record.

The original CLI continues to own authentication. Commands such as `codex login`, `claude auth`, `grok --help`, and `kimi --version` pass through without telemetry.

```sh
# Immediate, process-only bypass: run the original CLI and write nothing.
TOKENPILOT_BYPASS=1 codex

# Set the default mode for future sessions.
tokenpilot mode observe
tokenpilot mode balanced
tokenpilot mode deep
tokenpilot mode off

# Check the local platform, Node, wrappers, original CLIs, provider limits,
# and optional skill destinations. This never creates telemetry or config.
tokenpilot doctor

# Inspect the local state or mark completed sessions unavailable until a
# provider-specific correlated telemetry adapter is installed.
tokenpilot status
tokenpilot collect

# Optional, content-free session classification for the experiment.
tokenpilot sessions --unclassified
tokenpilot classify <run-id> --kind bugfix --outcome completed
# Use benchmark only for controlled checks, never for ordinary work.
tokenpilot classify <run-id> --kind benchmark --outcome completed

# Short audit summary for the latest seven days.
tokenpilot report
# Full comparison evidence or adapter limitations.
tokenpilot report --view detail
tokenpilot report --view diagnostics
```

### Optional API-equivalent USD

TokenPilot never fetches prices, guesses a model, or treats a personal subscription as a bill. If an API-equivalent view is useful, add a price profile manually and select it per provider:

```sh
tokenpilot pricing add codex codex-model-example \
  --label "My manually verified Codex API profile" \
  --version 2026-08-14 \
  --input-usd-per-million 0 \
  --cached-input-usd-per-million 0 \
  --cache-creation-usd-per-million 0 \
  --output-usd-per-million 0
tokenpilot pricing set codex codex-model-example
tokenpilot pricing list
tokenpilot pricing off codex
```

Use rates you have independently verified for the intended provider/model. The selected profile and its full rate snapshot are stored with each new session, so historical reports remain reproducible after a later price change. USD is shown only when the provider published all compatible categories: new input, cached input, cache creation, output, and reasoning when the chosen profile prices reasoning. A provider total alone never receives a USD conversion. Every report labels this as **API-equivalent USD, not a provider bill**.

Provider-published numeric measurement is automatic in these non-interactive commands; their output is forwarded unchanged and TokenPilot persists only the recognized numbers:

```sh
# Codex final provider-reported session total
codex exec "implement the requested change"

# Grok's published input/cache/output/reasoning counters
grok --output-format json --single "summarize this change"
```

Normal interactive Codex and Grok sessions retain their original TTY streams and record a content-free envelope when the provider does not publish a safe correlated counter.

`off` and `TOKENPILOT_BYPASS=1` are immediate no-telemetry bypasses. If TokenPilot cannot initialize its telemetry database, it starts the original CLI normally.

## Data model and privacy

Raw local telemetry stays in `~/.local/share/tokenpilot/telemetry.sqlite` on macOS and `~/.tokenpilot/data/telemetry.sqlite` on Linux, with user-only directory permissions. The database contains only:

- provider, mode, CLI version, timestamps, exit status, and collection status;
- numeric usage counters (new/cached input, cache creation, output, reasoning, model calls, and a provider-reported total when no category breakdown exists);
- numeric compaction/retry/model-switch events; and
- optional task category and outcome.

The source code rejects fields named `prompt`, `message`, `content`, `token`, `credential`, `command`, `args`, and similar before storage. `.gitignore` excludes the database, raw JSONL, and personal reports. The launcher never takes the provider executable from config; it resolves only a regular executable outside the TokenPilot shim directory whose containing directory is not group- or world-writable.

Before sharing an aggregate report, review it manually. Do not put company telemetry, account names, internal project names, or raw session files in this repository.

## Telemetry quality

TokenPilot treats provider logs as an evolving local interface. It never scans provider folders, timestamps, JSONL, or Wire output: none of those sources alone proves a log line belongs to the current wrapper session. `tokenpilot collect` consequently marks a finished envelope `unavailable` rather than inventing numbers or mixing activity.

For a local Claude session, TokenPilot starts a short-lived receiver on `127.0.0.1` and configures Claude's documented OTLP **metrics-only** exporter for that child process. It disables logs, traces, prompt/response logging, tool-detail logging, raw API bodies, account UUIDs, session IDs, and custom resource labels. Each receiver has an unguessable per-run header and accepts only the documented `claude_code.token.usage` metric. It extracts only the numeric `input`, `cacheRead`, `cacheCreation`, and `output` counters; every other field is discarded before storage. It does not change Claude authentication or send telemetry over the network.

Claude's metrics can still contain account identity attributes in the transient provider export. TokenPilot neither logs nor stores them, but this is why the receiver is local, authenticated per session, and destroyed when the CLI exits.

The four adapters are all available for observation:

| Provider | Automatic counter import | Current optimisation |
| --- | --- | --- |
| Claude | Metrics-only local OTLP receiver, correlated by the wrapper's unique per-run endpoint header | cache-stable prefix, medium effort |
| Codex | Current CLIs: metrics-only local OTLP for interactive and `exec`; older CLIs: only the published `exec` total | medium effort, low verbosity, 64k compaction when `--config` is advertised |
| Grok | For explicit `grok --output-format json --single`, parses only its top-level numeric `usage` object | medium effort |
| Kimi | Not yet enabled: documented run correlation required | version-gated only |

Claude handles prompt caching itself, and its cache prefix is sensitive to model, tools, MCP connections, and context changes. [Claude Code documentation](https://code.claude.com/docs/en/prompt-caching) explains these limits. Codex exposes user-level profiles, reasoning effort, automatic compaction, and telemetry configuration; its official configuration reference is the source of truth for any later adapter experiment. [OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-reference)

## Personal experiment

1. Install once, then use the CLIs normally. Sessions are measured automatically and can be classified only when you are comfortable doing so.
2. Run `/tokenpilot`, `$tokenpilot`, or `/skill:tokenpilot` at any time for the rolling seven-day report. Claude and Codex measure normal sessions through a local metrics-only receiver; Grok measures explicit JSON single-turn sessions. Other sessions correctly show unavailable rather than an estimate.
3. `balanced` is the initial mode; set `tokenpilot mode observe` to establish an unchanged-only baseline or use `deep`/`off` as immediate controls. A verified provider policy is applied only when the CLI advertises the necessary flags.
4. A reduction is validated only after five measured baseline and five measured treatment sessions for the same provider, known non-benchmark task type, complete cache-aware total basis, policy version, and price-profile snapshot. `unknown` and benchmark work can only be a preliminary signal and never a savings claim.
5. Use `TOKENPILOT_BYPASS=1 <provider>` or `tokenpilot mode off` for an immediate no-telemetry bypass. `tokenpilot mode deep` preserves the native provider settings while retaining measurement.

There is intentionally no pre-set savings target. Coverage comes first. Each provider then shows new input, cache reads, cache creation, token pressure, a complete cache-aware total, latency, and opaque local evidence IDs. A complete total is the verified provider total when it includes cache reads; otherwise it is `new + cached + cache creation + output + reasoning`. If new input moves into cache reads while that total changes by less than 2%, TokenPilot emits `cache-shift`, never a percentage, tokens avoided, or USD avoided. `cache-shift`, limited measurement, and missing comparable baselines have no savings number. A preliminary signal is directional only; **validated reduction** is the sole reduction claim. A changed policy or price snapshot starts a new paired experiment; TokenPilot never compares it against an earlier baseline.

## Removing TokenPilot

```sh
tokenpilot uninstall --dry-run
tokenpilot uninstall
```

Uninstall removes the shims, the TokenPilot block it owns in the shell startup file, and its user LaunchAgent. It does not remove the local database; delete that only after reviewing whether the personal experiment is complete.

## Enterprise handoff

See [docs/JOHN.md](docs/JOHN.md). A company pilot needs a company-owned repository, Security approval, company storage for aggregate metrics, an opt-in user-level agent, a global kill switch, and provider-specific correlated telemetry that has passed a privacy review. It must not depend on this personal repository or export company telemetry to it.
