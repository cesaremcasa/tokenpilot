# Real model evaluation — October 5, 2026

24 real CLI calls: eight Codex models (CLI 0.155.1) and four Grok models (CLI 1.0.46), one observe/reduce pair per model. Each independently fixed the existing public [PR55 argument-order bug](https://github.com/cesaremcasa/tokenpilot/pull/55) from baseline `dfd4bcb06093f0644ef7002eee8616ac10d09830`. All 24 patches passed the five code-correctness checks. Reduction acceptance failed for GPT-5.5: its treatment increased use by 30.9%. That policy is not approved for this model and requires correction and a predeclared repeat evaluation.

| Model | Observe tokens | Reduce tokens | Observed change |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` | 158,512 | 155,314 | -2.0% |
| `gpt-6-sol` | 270,286 | 169,467 | -37.3% |
| `gpt-6-luna` | 239,198 | 187,111 | -21.8% |
| `gpt-5.6-sol` | 174,664 | 109,050 | -37.6% |
| `gpt-5.6-terra` | 210,024 | 139,223 | -33.7% |
| `gpt-5.6-luna` | 177,405 | 131,175 | -26.1% |
| `gpt-daybreak-blue-latest` | 203,594 | 132,554 | -34.9% |
| `gpt-5.5` | 204,734 | 267,926 | +30.9% |
| `grok-4.7` | 474,612 | 285,345 | -39.9% |
| `grok-4.7-build-fast` | 541,265 | 303,571 | -43.9% |
| `grok-4.6` | 340,908 | 210,815 | -38.2% |
| `grok-4.5` | 458,265 | 448,821 | -2.1% |

Totals include cached input. Negative changes mean fewer tokens in this single matched task; positive changes mean more. These observations do not establish general reduction or quality equivalence. Missing optional counters are retained as unavailable in the [numeric evidence](evidence/2026-10-05-model-matrix.json). No prompts or provider responses are included.

Claude was not authenticated on this host and was not tested. Kimi currently lacks an enabled correlated measurement channel; no token comparison is claimed.
