# Measurement methodology

TokenPilot measures token reduction, not provider billing and not control of the provider's cache. Provider caches remain provider-side. The experiment changes documented session settings and measures the resulting provider-published counters.

## Categories

TokenPilot keeps these fields distinct:

- `input new`: non-cached input;
- `cache read`: previously cached input reused by the provider;
- `cache created`: input written into cache when the provider publishes it;
- `output`: generated output tokens;
- `reasoning`: reasoning tokens when separately published;
- `provider-reported total`: accepted only when its cache semantics are known; and
- latency, retries, compactions, and task outcome.

Token pressure is:

```text
input new + cache created + output + reasoning
```

Cache reads are excluded from token pressure because they represent reuse, but they remain part of the complete cache-aware total.

## Complete comparison total

The comparison total is chosen in this order:

1. a provider-reported total whose semantics are verified to include cache reads; otherwise
2. `input new + cache read + cache created + output + reasoning` when every required category is available.

A provider total is never mixed with category totals inside one comparison.

Grok External OTEL publishes `input` as full input including its `cache_read` component. TokenPilot subtracts cache reads before storing new input. Reports apply the same normalization to legacy `grok-otlp-metrics-v1` rows without rewriting the local audit history.

## Cache-shift detector

A decrease in new input is not automatically a reduction. If cache reads rise in the opposite direction by at least half the magnitude of the new-input decrease and the complete total changes by less than 2%, TokenPilot labels the result `cache-shift`.

`cache-shift`, `limited`, and `incomparable` states never publish a reduction percentage, avoided tokens, or avoided USD.

## Comparison states

| State | Meaning | Numeric claim |
| --- | --- | --- |
| `limited` | Correlated complete counters are unavailable. | No reduction estimate. |
| `incomparable` | Provider, task, policy, basis, or price snapshot does not match. | No reduction estimate. |
| `cache-shift` | New input moved into cache while the complete total stayed effectively flat. | No reduction estimate. |
| `preliminary-signal` | Comparable direction exists, but validation requirements are incomplete. | Observed metrics may be shown, never called a reduction; economy fields stay suppressed and the concise scoreboard shows measured use instead. |
| `validated-reduction` | Complete matched cohort satisfies every validation rule and avoided tokens are positive. | May report reduction and avoided tokens. |

## Validation requirements

A reduction is validated only when all of the following are true:

- same provider;
- known task type, excluding `unknown` and `benchmark`;
- same versioned treatment policy;
- same complete-total basis;
- same price snapshot, including no-price as a distinct snapshot;
- at least three measured baselines and three measured treatments;
- positive avoided tokens and positive median reduction;
- cache-shift detector is false; and
- formal quality evidence; the observed outcome safeguard below is not sufficient on its own.

Providers are never summed. Benchmarks are retained as compatibility evidence but excluded from real-work validation.

The concise scoreboard labels a `cache-shift` directly and may show only its neutral expected → used totals; it never prints a percentage or reduction headline for that state.

## Observed quality safeguard

The report records a conservative, content-free observation over the closed outcome enum `completed`, `rework`, or `abandoned`. `observed-not-degraded` means only that treatment completion was no lower and treatment rework/abandonment were no higher in this sample; it is not statistical equivalence, non-inferiority, or formal quality evidence. `unknown` outcomes or degraded observations fail open to a preliminary signal. This PR has no formal quality test, confidence interval, margin, or power analysis, so no observed outcome gate can authorize `validated-reduction`; economy fields remain suppressed until formal evidence exists.

Outcome labels are local, user-supplied classifications and can be misclassified or gamed. Do not relabel a weak result as `completed` to unlock a claim; retain `unknown` when the outcome is not independently clear and review any future quality evidence outside this content-free telemetry path.

## Median and cohort totals

The headline percentage compares the median complete total per session. Cohort avoided tokens use the baseline median multiplied by the number of treatment sessions, minus the recorded treatment total. These percentages can differ and are both labeled.

Latency uses the baseline and treatment median session durations. A faster result does not prove equal task quality; task outcome, retries, rework, and abandonment remain separate evidence.

## Optional API-equivalent USD

TokenPilot never fetches prices or guesses the model. A user may manually create and select a versioned pricing profile. The complete rate snapshot is attached at session start so historical calculations remain reproducible.

USD appears only when every published category has a compatible selected rate. Cache reads use the cached-input rate, cache creation uses its own rate, and reasoning is priced only when explicitly configured. A provider total without categories receives no conversion.

All currency output is labeled **API-equivalent USD, not a provider bill**. Subscription use is never represented as money actually saved.

## Audit trail

`tokenpilot sessions` and the detailed report expose opaque run IDs, timestamps, provider, mode, policy, task category/outcome, measurement state, total basis, price snapshot, and closed unavailability reason. They do not expose content or provider account identity.

The concise report is a rolling last-24-hours window plus the last 7 days. Validated reductions and cache shifts show expected and used tokens; preliminary, incomparable, and limited cohorts show measured use without an economy claim. Use:

```sh
tokenpilot report
tokenpilot report --provider claude
tokenpilot report --view detail
tokenpilot report --view diagnostics
```
