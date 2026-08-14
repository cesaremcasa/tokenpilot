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

Version 0.1 records a content-free session envelope. Its default mode is `observe`; it never changes model, effort, tools, prompt, session, or context. Personal Claude and Codex sessions use separate, authenticated metrics-only local receivers described below. Grok JSON single-turn sessions can additionally publish their own numeric totals directly to the wrapper process; TokenPilot accepts only those narrow numeric fields and never scans ambient session folders. Kimi remains envelope-only until it exposes a safe, correlated counter source. This prevents a personal database from accidentally collecting unrelated or company activity.

`balanced` is a durable 50/50 provider-local experimental assignment and a real token-reduction treatment. Its first assignment per provider is random; later sessions alternate between `observe` and `balanced`, even across terminal restarts. Task type is intentionally classified only after a session, so it never influences launch-time assignment. Before every treated session, TokenPilot asks only the installed provider CLI for `--help`. It injects a policy only if that exact local version advertises the required flag. A failed probe or missing capability starts the original CLI unchanged.

| Provider | `balanced` policy | Safety boundary |
| --- | --- | --- |
| Claude | Excludes dynamic system-prompt sections and sets medium effort. | Session arguments only; native tools, MCP, and provider config are not edited. |
| Codex | Sets medium reasoning effort, low verbosity, and automatic compaction at 64k tokens. | Session `--config` overrides only; prompt OTEL export remains disabled. |
| Grok | Sets medium reasoning effort. | Does not use API-only cache keys. |
| Kimi | Disables thinking and bounds steps/retries only when the local CLI exposes all three session flags. | Current Kimi 0.29.x is observed unchanged because it does not advertise those flags. |

The wrapper prints a one-line notice when a treatment is active. It never stores the injected arguments; reports retain only the TokenPilot policy name.

## Requirements

- macOS or Linux and Node.js 22.5 or newer
- At least one provider CLI already installed and working: `claude`, `codex`, `grok`, or `kimi`
- zsh or bash for automatic integrated-terminal `PATH` setup

## Install from this repository

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js install
exec "$SHELL" -l
```

The installer creates the `tokenpilot` command and per-provider shims at `~/.tokenpilot/bin`, adds that directory to `~/.zshrc` or `~/.bashrc`, and installs the `tokenpilot` report skill automatically. On macOS it also starts a user-only LaunchAgent; on Linux each finished wrapped session finalizes its own collection state, so no system service or root access is required. It also copies the compiled runtime into private TokenPilot state, so the installed commands keep working if the cloned checkout is moved, deleted, quarantined, or has restrictive macOS permissions. It never uses `sudo`.

The same versioned skill is installed per user, not per repository or company account:

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

# Inspect the local state or mark completed sessions unavailable until a
# provider-specific correlated telemetry adapter is installed.
tokenpilot status
tokenpilot collect

# Optional, content-free session classification for the experiment.
tokenpilot sessions --unclassified
tokenpilot classify <run-id> --kind bugfix --outcome completed
# Use benchmark only for controlled checks, never for ordinary work.
tokenpilot classify <run-id> --kind benchmark --outcome completed

# Aggregate report for the latest seven days. It intentionally never compares
# raw token totals across providers.
tokenpilot report
```

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

Raw local telemetry stays in `~/.local/share/tokenpilot/telemetry.sqlite`, with user-only directory permissions. The database contains only:

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
| Codex | For `codex exec`, parses only the provider-published final numeric total from that child process | medium effort, low verbosity, 64k compaction |
| Grok | For explicit `grok --output-format json --single`, parses only its top-level numeric `usage` object | medium effort |
| Kimi | Not yet enabled: documented run correlation required | version-gated only |

Claude handles prompt caching itself, and its cache prefix is sensitive to model, tools, MCP connections, and context changes. [Claude Code documentation](https://code.claude.com/docs/en/prompt-caching) explains these limits. Codex exposes user-level profiles, reasoning effort, automatic compaction, and telemetry configuration; its official configuration reference is the source of truth for any later adapter experiment. [OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-reference)

## Personal experiment

1. Install once, then use the CLIs normally. Sessions are measured automatically and can be classified only when you are comfortable doing so.
2. Run `/tokenpilot`, `$tokenpilot`, or `/skill:tokenpilot` at any time for the rolling seven-day report. Claude and Codex measure normal sessions through a local metrics-only receiver; Grok measures explicit JSON single-turn sessions. Other sessions correctly show unavailable rather than an estimate.
3. Set `tokenpilot mode balanced` to activate the version-gated treatment and immediate bypass controls. It applies a verified provider policy only when the CLI advertises the necessary flags.
4. A comparison becomes `ready` only after five measured baseline and five measured treatment sessions for the same provider and task type. Until then it is shown as preliminary rather than a savings claim.
5. Use `TOKENPILOT_BYPASS=1 <provider>` or `tokenpilot mode off` for an immediate no-telemetry bypass. `tokenpilot mode deep` preserves the native provider settings while retaining measurement.

There is intentionally no pre-set savings target. The report begins with a simple per-provider **reduction and latency summary**: percentage token reduction, estimated tokens avoided, baseline-to-treatment median duration, and whether end-to-end local CLI latency became faster or slower. It also provides matched within-provider comparisons of median token pressure, variation, duration, and classified completion rate. **Estimated tokens avoided** is the matched observe median multiplied by the number of treatment sessions, minus the tokens actually recorded for those treatment sessions. This is a token-only counterfactual estimate—not a money calculation—and it can be negative when a policy uses more tokens. It is reported only within the same provider, task type, measurement basis, and policy version. When a policy changes, TokenPilot starts a new paired experiment: it never compares that new version against baseline sessions allocated to an earlier policy.

## Removing TokenPilot

```sh
tokenpilot uninstall --dry-run
tokenpilot uninstall
```

Uninstall removes the shims, the TokenPilot block it owns in the shell startup file, and its user LaunchAgent. It does not remove the local database; delete that only after reviewing whether the personal experiment is complete.

## Enterprise handoff

See [docs/JOHN.md](docs/JOHN.md). A company pilot needs a company-owned repository, Security approval, company storage for aggregate metrics, an opt-in user-level agent, a global kill switch, and provider-specific correlated telemetry that has passed a privacy review. It must not depend on this personal repository or export company telemetry to it.
