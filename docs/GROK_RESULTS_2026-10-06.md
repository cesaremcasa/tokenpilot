# Grok Build measured reductions — October 6, 2026

TokenPilot compared the same public flag-order maintenance task with and without the Grok v8 policy. Every arm passed focused tests, typecheck, build, independent behavior and file-scope checks. No conversations, credentials or private paths are included in the evidence.

| Model | Measured reduction |
| --- | ---: |
| grok-4.7 | 65.49% |
| grok-4.7-build-fast | 76.50% |
| grok-4.6 | 57.89% |
| grok-4.5 | 57.10% |

All four tested models exceeded 42% in this task. The simple mean is 64.24%. These are one-pair controlled observations, not a universal or statistically repeated-trial guarantee.

The treatment keeps all native tools and optional features. It uses low reasoning effort, the native verbatim prompt flag, bounded source/test inspection, grouped checks and concise completion. Individual contributions of these controls were not isolated.

[Numeric CLI receipts and validation](evidence/2026-10-06/grok-reductions.json) include cached input in the comparison. Session cache percentages and subscription-quota percentages are separate metrics.

Grok Bot supports skills and a cloud terminal, but its parent LLM usage is not measured by a wrapped Grok Build subprocess. This report establishes CLI savings only.
