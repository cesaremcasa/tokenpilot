# Reduction retest — October 5, 2026

An increase rejects the treatment. The earlier GPT-5.5 increase and the rejected broad v4/v5/v6/v7 trials remain recorded; none were removed to improve the outcome.

| Model | Policy | Valid pairs | Observed lower use |
| --- | --- | ---: | ---: |
| `gpt-6-astra` | `codex-balanced-v3` | 1 | 10.07% |
| `gpt-6-sol` | `codex-balanced-v3` | 1 | 16.09% |
| `gpt-6-luna` | `codex-balanced-v8` | 3 | 2.35%–53.01% |
| `gpt-5.6-sol` | `codex-balanced-v3` | 1 | 41.62% |
| `gpt-5.6-terra` | `codex-balanced-v3` | 1 | 28.87% |
| `gpt-5.6-luna` | `codex-balanced-v3` | 1 | 2.84% |
| `gpt-daybreak-blue-latest` | `codex-balanced-v7` | 3 | 0.59%–21.97% |
| `gpt-5.5` | `codex-balanced-v4` | 4 | 11.94%–33.26% |

All listed pairs delivered the real PR55 fix and passed independent flag-order, argument-preservation, complete-value unknown-option fail-open, test, typecheck, build and diff checks. Each row includes the whole predeclared series for that effective policy. The six unchanged policies are carried forward from their real scoped tests; subsequent changes affect only the failed models. These are task-specific observations, not a guarantee for future work.

The [evidence ledger](evidence/2026-10-05-reduction-retest.json) retains all 102 native calls, raw numeric receipts, patch hashes, failed policies and the evaluator audits. Two evaluator bookkeeping defects affected status labels; the reconciliation uses actual wrapper exit/timeout records and provider receipts uniformly, without repeating calls. V6 command diagnostics were not captured and are marked unavailable.

Codex treatment requires an unambiguous explicit native model selector, such as `codex --model gpt-5.5`. Config/profile-only, absent or ambiguous selection collects available metrics without injecting a treatment. Model changes inside a running interactive session require a new launch to select the corresponding policy. No model is substituted and no native tool is removed.
