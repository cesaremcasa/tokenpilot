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

Version 0.1 records a content-free session envelope. Its default mode is `observe`; it never changes model, effort, tools, prompt, session, or context. Automatic token-counter import is deliberately disabled until an adapter can prove, using a provider-documented session identifier, that a local event belongs to the wrapper invocation. This prevents a personal database from accidentally collecting unrelated or company activity.

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
npm ci --ignore-scripts
npm run build
node dist/cli.js install
exec "$SHELL" -l
```

The installer creates per-user shims at `~/.tokenpilot/bin`, adds that directory to `~/.zshrc` or `~/.bashrc`, and starts a user-only macOS LaunchAgent. It never uses `sudo`.

Before measuring or applying a treatment, explicitly mark the terminal as personal. Provider CLIs do not expose a reliable account-scope signal, so TokenPilot defaults to transparent pass-through with no record and no optimization. Set this only in a VS Code terminal profile used exclusively with your personal accounts; do not put it in a shared shell profile or a company terminal.

```sh
export TOKENPILOT_PERSONAL_SESSION=1
```

After that one-time terminal-profile setup, typing `claude`, `codex`, `grok`, or `kimi` is unchanged. To run a single personal session without changing the profile, prefix the command with `TOKENPILOT_PERSONAL_SESSION=1`.

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

Without `TOKENPILOT_PERSONAL_SESSION=1`, the command remains a transparent provider launch and writes no TokenPilot state. This is intentional: it prevents a personal installation from recording an accidentally opened company-account session.

The original CLI continues to own authentication. Commands such as `codex login`, `claude auth`, `grok --help`, and `kimi --version` pass through without telemetry.

```sh
# Immediate, process-only bypass: run the original CLI and write nothing.
TOKENPILOT_BYPASS=1 codex

# Explicit personal session: permits measurement and a verified treatment.
TOKENPILOT_PERSONAL_SESSION=1 codex

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
tokenpilot classify <run-id> --kind bugfix --outcome completed

# Aggregate report. It intentionally never compares raw token totals across providers.
tokenpilot report --days 7 --format md
```

`off`, an absent `TOKENPILOT_PERSONAL_SESSION=1`, and `TOKENPILOT_BYPASS=1` are fail-open bypasses. If TokenPilot cannot initialize its telemetry database, it starts the original CLI normally.

## Data model and privacy

Raw local telemetry stays in `~/.local/share/tokenpilot/telemetry.sqlite`, with user-only directory permissions. The database contains only:

- provider, mode, CLI version, timestamps, exit status, and collection status;
- numeric usage counters (new/cached input, cache creation, output, reasoning, model calls);
- numeric compaction/retry/model-switch events; and
- optional task category and outcome.

The source code rejects fields named `prompt`, `message`, `content`, `token`, `credential`, `command`, `args`, and similar before storage. `.gitignore` excludes the database, raw JSONL, and personal reports. The launcher never takes the provider executable from config; it resolves only a regular executable outside the TokenPilot shim directory whose containing directory is not group- or world-writable.

Before sharing an aggregate report, review it manually. Do not put company telemetry, account names, internal project names, or raw session files in this repository.

## Telemetry quality

TokenPilot treats provider logs as an evolving local interface. V0.1 does **not** scan provider folders, timestamps, JSONL, or Wire output: none of those sources alone proves a log line belongs to the current wrapper session. `tokenpilot collect` consequently marks finished envelopes `unavailable` rather than inventing numbers or mixing activity. A future adapter may add counters only after it has a provider-documented, tested run correlation and explicit privacy review.

The four adapters are all available for observation:

| Provider | Automatic counter import | V0.1 optimisation |
| --- | --- | --- |
| Claude | Not yet enabled: documented run correlation required | cache-stable prefix, medium effort, core tools |
| Codex | Not yet enabled: documented run correlation required | medium effort, low verbosity, 64k compaction |
| Grok | Not yet enabled: documented run correlation required | medium effort |
| Kimi | Not yet enabled: documented run correlation required | version-gated only |

Claude handles prompt caching itself, and its cache prefix is sensitive to model, tools, MCP connections, and context changes. [Claude Code documentation](https://code.claude.com/docs/en/prompt-caching) explains these limits. Codex exposes user-level profiles, reasoning effort, automatic compaction, and telemetry configuration; its official configuration reference is the source of truth for any later adapter experiment. [OpenAI Docs](https://learn.chatgpt.com/docs/config-file/config-reference)

## Seven-day personal experiment

1. In a VS Code terminal profile used only with personal accounts, set `TOKENPILOT_PERSONAL_SESSION=1` and run `tokenpilot mode observe` for seven days to establish a session and quality baseline.
2. Use the CLIs normally and classify sessions only when you are comfortable doing so.
3. Do not use the current reports for token-savings claims: automatic counters will be zero/unavailable until a documented per-provider correlator is added and tested.
4. Set `tokenpilot mode balanced` only to validate the version-gated optimization and the immediate bypass. It applies a verified provider treatment when the CLI advertises the necessary flags.
5. Once a correlator passes privacy review, repeat the baseline and the persisted 50/50 `balanced` experiment before claiming savings.
6. Use `TOKENPILOT_BYPASS=1 <provider>`, remove `TOKENPILOT_PERSONAL_SESSION`, or use `tokenpilot mode off` for an immediate no-telemetry bypass. `tokenpilot mode deep` preserves the native provider settings while retaining measurement.

There is intentionally no pre-set savings target. The report names the policy actually applied and provides matched within-provider comparisons of median token pressure, variation, duration, and classified completion rate.

## Removing TokenPilot

```sh
tokenpilot uninstall --dry-run
tokenpilot uninstall
```

Uninstall removes the shims, the TokenPilot block it owns in the shell startup file, and its user LaunchAgent. It does not remove the local database; delete that only after reviewing whether the personal experiment is complete.

## Enterprise handoff

See [docs/JOHN.md](docs/JOHN.md). A company pilot needs a company-owned repository, Security approval, company storage for aggregate metrics, an opt-in user-level agent, a global kill switch, and provider-specific correlated telemetry that has passed a privacy review. It must not depend on this personal repository or export company telemetry to it.
