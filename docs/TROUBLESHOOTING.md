# Troubleshooting

Start with:

```sh
tokenpilot --version
tokenpilot doctor
tokenpilot report --view diagnostics
```

`doctor` separates installation from measurement. `Installation: ready` can coexist with `Measurement: limited` when a provider modality does not publish correlated counters.

## The provider bypasses TokenPilot

```sh
command -v tokenpilot
command -v claude
command -v codex
command -v grok
command -v kimi
```

The expected launchers are under `~/.tokenpilot/bin`. Reinstall and start a new login shell:

```sh
node dist/cli.js install
exec "$SHELL" -l
tokenpilot doctor
```

Do not manually copy launchers or reorder the managed PATH block.

## Provider CLI not found

The TokenPilot launcher may exist even when the original provider CLI is absent. Install and authenticate the original provider CLI as the same OS user, then rerun `tokenpilot install`.

TokenPilot does not share logins or credentials between machines.

## Wrong Node.js in SSH or automation

TokenPilot requires Node.js 22.5+. A non-login SSH shell may resolve a system Node.js older than the version used in the terminal.

```sh
bash -ilc 'node --version; tokenpilot --version; tokenpilot doctor'
```

Run build/install automation in the user's login environment or configure an explicit supported Node.js runtime.

## Sessions exist but are unavailable

Unavailable means the session envelope exists but the provider did not publish a complete correlated numeric sample. It is not zero usage and not zero savings.

Common reasons include:

- provider quota or service error before complete counters;
- an older CLI without the documented telemetry surface;
- Grok without correlated External OTEL/JSON counters;
- Kimi, which is currently envelope-only while a safe correlated channel is unavailable;
- a collector that started but received no accepted metric; or
- an old total-only Codex path that cannot provide categories.

Never repair unavailable data by scraping provider history or estimating tokens.

## Report says cache-shift

Cache-shift means new input moved toward cache reads while the complete cache-aware total stayed effectively flat. It is not a reduction. Use the detail view to inspect new, cached, created, pressure, and total separately.

## Report says preliminary

The cohort is directionally comparable but lacks a validation requirement, commonly 5+5 measured sessions or a known non-benchmark task type. Continue normal use and classify only sessions you can categorize without entering task content.

## Kimi

Kimi launches through its original CLI without a TokenPilot REST/WebSocket bridge. It remains envelope-only until a content-free, child-authenticated measurement channel is available.

## Provider quota errors

A provider can reject a model even when TokenPilot is working. For example, the first Claude matrix reached the provider but Fable was blocked by the account limit. TokenPilot preserves the provider's exit status and output; it does not bypass subscriptions or quotas.

## Emergency bypass

```sh
TOKENPILOT_BYPASS=1 <provider>
tokenpilot mode off
```

The process bypass records nothing. `off` applies to future sessions until the mode changes.

## Safe upgrade or reinstall

Reinstalling preserves the database. Check the dry run first if the shell or skill directories were manually modified:

```sh
node dist/cli.js install --dry-run
node dist/cli.js install
```

The installer refuses to overwrite foreign launchers, modified managed blocks, unsafe directories, or third-party skills.
