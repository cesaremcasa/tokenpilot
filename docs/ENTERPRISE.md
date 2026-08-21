# Enterprise adoption

TokenPilot is created by Cesar Augusto / Mycellium Lab as a local-first, provider-neutral measurement and optimization layer. The MIT License permits organizational review, modification, and deployment, but the license does not replace an organization's security, legal, privacy, procurement, or provider-terms review.

## Developer experience

A developer continues to use the provider CLI and authentication already approved by the organization. TokenPilot adds no shared login, proxy, provider-independent cache, or credential store.

```sh
claude
codex
grok
kimi
```

The local launcher records a content-free session envelope and supported numeric counters. If measurement or treatment initialization fails, it opens the original CLI unchanged. Every user retains an immediate process bypass and persistent `off` mode.

## Recommended adoption stages

1. Review the source, [security policy](../SECURITY.md), [architecture](ARCHITECTURE.md), and [measurement methodology](MEASUREMENT.md).
2. Build from an approved commit in a company-controlled pipeline.
3. Begin with volunteer users and `observe` mode on approved machines/accounts.
4. Keep raw databases per user unless a separately approved aggregation design exists.
5. Validate coverage and unavailable reasons before enabling a treatment.
6. Enable one versioned provider policy at a time with a global rollback procedure.
7. Compare tokens per completed task, duration, retries, rework, abandonment, and user-reported quality.
8. Re-review an adapter whenever the provider CLI or documented telemetry surface changes.

## Data ownership

The default open-source product sends no telemetry to Mycellium Lab, GitHub, a cloud service, or an employer. Data remains local to the OS user.

If an organization builds aggregation, it should be a company-owned component and storage path with explicit retention, access control, deletion, opt-in, and incident-response rules. Do not send company telemetry to a contributor's personal repository or account.

## Evidence gate

An enterprise result is valid only inside the same provider, known task type, policy, metric basis, and price snapshot, with at least three measured baseline and three measured treatment sessions. Providers must never be combined into one token total or one savings percentage.

Cache reads, new input, cache creation, output, reasoning, pressure, and complete total remain distinct. A cache shift cannot be presented as reduction. Unsupported sessions remain unavailable rather than estimated.

## Treatment risk

Balanced policies intentionally change reasoning, verbosity, compaction, or tool breadth. They may not be appropriate for every task.

- Claude web, MCP, agent, notebook, and non-core tool work should use `deep`, `off`, or bypass.
- Kimi work is currently measurement-limited and has no TokenPilot treatment.
- A provider/model quota failure is a provider event, not a TokenPilot optimization result.
- Version gates reduce compatibility risk but do not replace a pilot on the organization's actual workflows.

## API-equivalent pricing

Optional price profiles are manually selected and snapshotted. They model API-equivalent categories and are never described as the actual bill or subscription savings. Billing integration is outside the default project scope.

## Minimum production controls

- company-approved build and distribution;
- documented owner and rollback process;
- opt-in or policy-based enrollment;
- `TOKENPILOT_BYPASS=1` and `off` available to developers;
- no root service;
- local or approved company-owned data storage;
- security monitoring for source and dependency updates;
- periodic provider-version compatibility checks; and
- a kill switch for every treatment policy.

## What Mycellium Lab does not receive

Using the open-source repository does not transmit prompts, responses, code, credentials, provider usage, reports, or company identifiers to Mycellium Lab. Any support request must use synthetic diagnostics and must not attach a user's database or raw provider output.
