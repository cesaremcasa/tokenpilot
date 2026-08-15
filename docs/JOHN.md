# TokenPilot: proposal for an enterprise pilot

## What it is

TokenPilot is a local, provider-neutral measurement layer for developer AI CLIs. A developer still opens the VS Code terminal and types `claude`, `codex`, `grok`, or `kimi`. Authentication remains entirely with that provider; TokenPilot adds no login and never reads credentials.

The tool records a content-free session envelope locally and can report it by provider, task class, and experimental mode. It does not proxy requests or create a provider-independent cache. Provider caches remain server-side. Current Claude and Codex CLIs can publish metrics to a short-lived, authenticated local receiver; older Codex falls back only to its published `exec` total, Grok only measures explicit one-turn JSON output, and Kimi is envelope-only. No provider folder is scanned and unavailable data is not estimated.

## Why start personally

The initial version is being tested only on the author's personal machine and personal accounts. This establishes whether the transparent launcher, version-gated optimization, privacy boundary, and experiment controls are reliable before any company system or account is involved.

No company prompt, code, account identifier, credential, raw session log, or usage data is transferred to the personal repository.

## Developer experience

- Same terminal, provider command, authentication, and UI.
- `balanced` is the installation default and alternates persistently with `observe` per provider, creating a matched baseline while exercising a version-gated treatment. `observe`, `deep`, `off`, and `TOKENPILOT_BYPASS=1` are immediate controls.
- The treatment applies only documented CLI controls for cache stability, reasoning, verbosity, tool breadth, and compaction. It never writes a provider config file or changes authentication.
- `TOKENPILOT_BYPASS=1 <provider>` bypasses the layer immediately.
- If telemetry fails, the original CLI opens normally.
- A developer may classify a finished task as completed, rework, or abandoned without entering task content.

## Evidence required before a savings claim

Where a provider-specific correlation is available, the personal experiment may report, per provider and task type:

- input/cache/output/reasoning counters;
- duration, retries, and compactions;
- completed, rework, and abandoned task signals; and
- observed differences between `observe` and the named provider-specific treatment, including whether a policy was actually applied.

The report separates measured coverage from unavailable sessions before displaying any directional result. It keeps new input, cache reads, cache creation, token pressure, and complete cache-aware totals separate. If new input moves into cache reads while the complete total stays within 2%, the result is `cache-shift`, never a saving. A result is validated only for classified non-benchmark work with at least five measured baseline and five measured treatment sessions in the same provider, task type, complete-total basis, policy version, and price-profile snapshot. `unknown` and benchmark rows remain preliminary signals, not savings. There is no pre-declared savings percentage.

An optional local price profile can model **API-equivalent USD** from category-level counters. The profile is manually selected, snapshotted at session start, never fetched from the network, and clearly labeled “API equivalent, not real billing.” Personal subscriptions are never represented as money actually saved.

## Proposed company pilot

1. Security and legal review the data contract and ownership model.
2. Recreate or transfer approved code into a company-owned repository; do not deploy directly from the personal GitHub repository.
3. Deploy an opt-in, per-user agent for a small volunteer group in `observe` mode.
4. Send only approved aggregate numeric metrics to company-owned storage.
5. Introduce one provider-specific optimization at a time, with a documented rollback and a global kill switch. Port only policies that have shown a reduction without deteriorating task outcome, retries, or duration.
6. Compare usage per completed task, retries, duration, and user-reported quality before any broader rollout.

## Risk controls

| Risk | Control |
| --- | --- |
| TokenPilot interferes with a CLI | Transparent launcher, integration tests, and fail-open behavior |
| A provider changes local session format | Do not scan ambient logs; require a documented session correlation, version-aware fixtures, and privacy review before enabling counters |
| Optimisation hurts quality | Start in observe mode; enable one change at a time; retain bypass and kill switch |
| Sensitive data leaks | No content fields in the data model; raw logs never exported; aggregate-only company storage |
| Personal and company IP mix | Separate repositories and no company data during the personal phase |
