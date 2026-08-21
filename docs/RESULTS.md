# First research snapshot — August 15, 2026

This document is a **historical snapshot**. It is not live TokenPilot output. A `/tokenpilot` or `tokenpilot report` on any machine must print that machine's current scoreboard, never this table.

This document is the first manually reviewed TokenPilot research snapshot published by Cesar Augusto / Mycellium Lab. It records what the local reports said at the end of the round; it is not a promise of future performance.

The Kimi figures below are historical only. The Kimi REST/WebSocket bridge was disabled during the subsequent Codex Security hardening audit, so current Kimi sessions run unchanged and remain envelope-only.

This snapshot predates the 0.4.16 reproducible artifact workflow and the 0.5 evidence terminology. Those distribution and reporting controls do not revise the recorded totals. Under the 0.5 contract, every percentage below is a preliminary observed cache-aware variation because the round did not include formal quality-equivalence evidence.

The next weekly snapshot is planned for Saturday, August 22, 2026. Future rounds should be appended as separate dated sections or files so earlier evidence remains reproducible.

## Environment

- TokenPilot 0.4.6
- Linux test host
- Node.js 22.23.1
- local, per-user SQLite telemetry
- `research` task classification for reduction cohorts
- no API pricing profile; USD-equivalent results unavailable
- no prompts, responses, source code, tool payloads, credentials, or provider logs retained

The four providers were measured independently. Token counts were never added across providers.

## Observed research results

| Provider / policy | Coverage | Baseline / treatment | Median total | Observed median change | Cohort expected / used / difference | Cohort change | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude / `claude-balanced-v7` | 45/46 | 5 / 5 | 87,247 → 29,691 | **66.0%** | 436,235 / 146,898 / 289,337 | 66.3% | 6s faster (35.3%) |
| Codex / `codex-balanced-v2` | 49/51 | 5 / 5 | 324,467 → 146,800 | **54.8%** | 1,622,335 / 722,273 / 900,062 | 55.5% | 60s faster (69.0%) |
| Grok / `grok-balanced-v4` | 39/40 | 5 / 5 | 421,809 → 242,148 | **42.6%** | 2,109,045 / 1,037,677 / 1,071,368 | 50.8% | 39s faster (68.4%) |
| Kimi / `kimi-balanced-v4` | 42/46 | 5 / 6 | 22,244 → 10,760 | **51.6%** | 133,464 / 64,710 / 68,754 | 51.5% | 1s faster (4.2%) |

Coverage is the provider's complete rolling seven-day coverage at snapshot time, not only the sessions in the selected matched cohort. Unavailable sessions are retained in the audit trail and excluded from token calculations.

## Category medians

| Provider | New input | Cache read | Cache created | Token pressure | Complete total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude | 547 → 550 | 67,964 → 14,147 | 14,815 → 6,544 | 17,557 → 7,722 | 87,247 → 29,691 |
| Codex | 44,115 → 33,944 | 281,344 → 111,360 | 0 → 0 | 49,267 → 35,440 | 324,467 → 146,800 |
| Grok | 232,795 → 144,279 | 185,728 → 96,384 | 0 → 0 | 236,081 → 145,764 | 421,809 → 242,148 |
| Kimi | 4,187 → 2,192 | 17,920 → 8,448 | 0 → 0 | 4,348 → 2,312 | 22,244 → 10,760 |

All four complete totals declined materially; none of these selected cohorts triggered the cache-shift rule.

## Cohort matching checks

Each row matched:

- the same provider;
- a known, non-benchmark `research` task type;
- the same versioned policy;
- the same category-total measurement basis;
- the same no-price snapshot;
- at least five measured baselines and five measured treatments; and
- positive avoided tokens without a cache shift.

Those checks establish a comparable directional cohort. They do not establish formal quality equivalence, so the 0.5 public beta does not call these rows validated reductions.

## Model and reasoning smoke matrix

Separately from the real-work cohorts, 63 advertised model/reasoning combinations were invoked with a fixed compatibility prompt:

- Claude: 15 combinations; 10 completed, 14 measured. Five Fable calls reached the provider but were rejected by the account's Fable limit.
- Codex: 33/33 completed and measured.
- Grok: 7/7 completed and measured.
- Kimi: 8/8 completed and measured across four models in provider-default and `thinking: off` modes.

These sessions were classified `benchmark`, so they cannot create a validated reduction claim.

## Limitations

- The sample is small and comes from one user/test host.
- Task classification is coarse and does not prove equal output quality.
- Provider services, models, quotas, and CLI telemetry can change.
- The results do not establish the same reduction for every model, repository, or developer.
- Kimi produced intermittent approximately three-minute unavailable sessions during the round. They were not counted as savings and did not cause a duplicate provider invocation.
- API-equivalent USD was not configured, so no currency claim is published.
- Personal subscription use is not a provider invoice and is never presented as money saved.

## Reading future rounds

Future snapshots should report coverage first, preserve provider separation, identify policy versions, show complete category totals, and retain unavailable sessions and reasons. A later round may be compared with this one, but sessions from different policy versions or measurement bases must not be silently merged.
