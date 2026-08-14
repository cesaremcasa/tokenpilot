# TokenPilot: proposal for an enterprise pilot

## What it is

TokenPilot is a local, provider-neutral measurement layer for developer AI CLIs. A developer still opens the VS Code terminal and types `claude`, `codex`, `grok`, or `kimi`. Authentication remains entirely with that provider; TokenPilot adds no login and never reads credentials.

The tool observes numeric usage and session-health signals locally, then reports aggregate metrics by provider, task class, and experimental mode. It does not proxy requests or create a provider-independent cache. Provider caches remain server-side.

## Why start personally

The initial version is being tested only on the author's personal machine and personal accounts. This establishes whether the transparent launcher, telemetry parsing, and experiment reporting are reliable before any company system or account is involved.

No company prompt, code, account identifier, credential, raw session log, or usage data is transferred to the personal repository.

## Developer experience

- Same terminal, provider command, authentication, and UI.
- `observe` is the default and makes no provider setting changes.
- `balanced` is a version-gated personal treatment: it applies only documented CLI controls for cache stability, reasoning, verbosity, tool breadth, and compaction. It never writes a provider config file or changes authentication.
- `TOKENPILOT_BYPASS=1 <provider>` bypasses the layer immediately.
- If telemetry fails, the original CLI opens normally.
- A developer may classify a finished task as completed, rework, or abandoned without entering task content.

## Evidence produced

The personal experiment reports, per provider and task type:

- input/cache/output/reasoning counters;
- duration, retries, and compactions;
- completed, rework, and abandoned task signals; and
- observed differences between `observe` and the named provider-specific treatment, including whether a policy was actually applied.

There is no pre-declared savings percentage. The decision is based on measured results and quality signals, not a token-reduction promise.

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
| A provider changes local session format | Version-aware parser fixtures; mark telemetry unavailable rather than estimate |
| Optimisation hurts quality | Start in observe mode; enable one change at a time; retain bypass and kill switch |
| Sensitive data leaks | No content fields in the data model; raw logs never exported; aggregate-only company storage |
| Personal and company IP mix | Separate repositories and no company data during the personal phase |
