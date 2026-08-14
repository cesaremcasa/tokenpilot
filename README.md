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

Version 0.1 records a session envelope and reads numeric counters from local session telemetry after the CLI exits. Its default mode is `observe`; it never changes model, effort, tools, prompt, session, or context.

`balanced` is a stored 50/50 experimental assignment and a real token-reduction treatment. Before every treated session, TokenPilot asks only the installed provider CLI for `--help`. It injects a policy only if that exact local version advertises the required flag. A failed probe or missing capability starts the original CLI unchanged.

| Provider | `balanced` policy | Safety boundary |
| --- | --- | --- |
| Claude | Excludes dynamic system-prompt sections, sets medium effort, and keeps the `Read,Edit,Glob,Grep,Bash` core tool set. | Session arguments only; no MCP or provider config is edited. |
| Codex | Sets medium reasoning effort, low verbosity, and automatic compaction at 64k tokens. | Session `--config` overrides only; prompt OTEL export remains disabled. |
| Grok | Sets medium reasoning effort. | Does not use API-only cache keys. |
| Kimi | Disables thinking and bounds steps/retries only when the local CLI exposes all three session flags. | Current Kimi 0.29.x is observed unchanged because it does not advertise those flags. |

The wrapper prints a one-line notice when a treatment is active. It never stores the injected arguments; reports retain only the TokenPilot policy name.

## Requirements

- macOS and Node.js 22.5 or newer
- At least one provider CLI already installed and working: `claude`, `codex`, `grok`, or `kimi`
- zsh or bash for automatic integrated-terminal `PATH` setup

## Install from this repository

```sh
npm install
npm run build
node dist/cli.js install
exec "$SHELL" -l
```

The installer creates per-user shims at `~/.tokenpilot/bin`, adds that directory to `~/.zshrc` or `~/.bashrc`, and starts a user-only macOS LaunchAgent. It never uses `sudo`.

Preview its changes without writing anything:

```sh
node dist/cli.js install --dry-run
```

For development, set `TOKENPILOT_HOME`, `TOKENPILOT_CONFIG_HOME`, and `TOKENPILOT_DATA_HOME` to temporary directories. This keeps tests and experiments isolated from real data.

## Daily use and controls

Normal use is unchanged:

```sh
codex
```

The original CLI continues to own authentication. Commands such as `codex login`, `claude auth`, `grok --help`, and `kimi --version` pass through without telemetry.

```sh
# Immediate, process-only bypass: run the original CLI and write nothing.
TOKENPILOT_BYPASS=1 codex

# Set the default mode for future sessions.
tokenpilot mode observe
tokenpilot mode balanced
tokenpilot mode deep
tokenpilot mode off

# Inspect the local state or collect completed sessions now.
tokenpilot status
tokenpilot collect

# Optional, content-free session classification for the experiment.
tokenpilot classify <run-id> --kind bugfix --outcome completed

# Aggregate report. It intentionally never compares raw token totals across providers.
tokenpilot report --days 7 --format md
```

`off` and `TOKENPILOT_BYPASS=1` are fail-open bypasses. If TokenPilot cannot initialize its telemetry database, it starts the original CLI normally.

## Data model and privacy

Raw local telemetry stays in `~/.local/share/tokenpilot/telemetry.sqlite`, with user-only directory permissions. The database contains only:

- provider, mode, CLI version, timestamps, exit status, and collection status;
- numeric usage counters (new/cached input, cache creation, output, reasoning, model calls);
- numeric compaction/retry/model-switch events; and
- optional task category and outcome.

The source code rejects fields named `prompt`, `message`, `content`, `token`, `credential`, `command`, `args`, and similar before storage. `.gitignore` excludes the database, raw JSONL, and personal reports.

Before sharing an aggregate report, review it manually. Do not put company telemetry, account names, internal project names, or raw session files in this repository.

## Telemetry quality

TokenPilot treats provider logs as an evolving local interface. It records only files touched during the run window; when it cannot safely correlate telemetry, it marks the run `unavailable` rather than inventing numbers. Adapter parsers and fixtures must be updated and tested after each provider CLI change.

The four adapters are all available for observation:

| Provider | Source | V0.1 optimisation |
| --- | --- | --- |
| Claude | local session files | cache-stable prefix, medium effort, core tools |
| Codex | local rollout/session files | medium effort, low verbosity, 64k compaction |
| Grok | local session files | medium effort |
| Kimi | local session/Wire files | version-gated only |

Claude handles prompt caching itself, and its cache prefix is sensitive to model, tools, MCP connections, and context changes. [Claude Code documentation](https://code.claude.com/docs/en/prompt-caching) explains these limits. Codex exposes user-level profiles, reasoning effort, automatic compaction, and telemetry configuration; its official configuration reference is the source of truth for any later adapter experiment. [OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-reference)

## Seven-day personal experiment

1. Run `tokenpilot mode observe` for seven days on personal accounts only to establish a clean baseline.
2. Use the CLIs normally and classify sessions only when you are comfortable doing so.
3. Run `tokenpilot report --days 7 > personal-week-1.md`; review the file before retaining or sharing it.
4. Set `tokenpilot mode balanced` for the next period. Every new session receives a stored 50/50 assignment to `observe` or the verified provider treatment.
5. Use `TOKENPILOT_BYPASS=1 <provider>` or `tokenpilot mode off` for an immediate no-telemetry bypass. `tokenpilot mode deep` preserves the native provider settings while retaining measurement.

There is intentionally no pre-set savings target. The report names the policy actually applied and provides matched within-provider comparisons of median token pressure, variation, duration, and classified completion rate.

## Removing TokenPilot

```sh
tokenpilot uninstall --dry-run
tokenpilot uninstall
```

Uninstall removes the shims, the TokenPilot block it owns in the shell startup file, and its user LaunchAgent. It does not remove the local database; delete that only after reviewing whether the personal experiment is complete.

## Enterprise handoff

See [docs/JOHN.md](docs/JOHN.md). A company pilot needs a company-owned repository, Security approval, company storage for aggregate metrics, an opt-in user-level agent, and a global kill switch. It must not depend on this personal repository or export company telemetry to it.
