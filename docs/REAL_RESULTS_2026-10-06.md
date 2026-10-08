# Real measured results — October 6, 2026

Real Codex 0.160.1 runs compared the same maintenance task with and without TokenPilot. Both arms passed focused tests, typecheck, build, independent behavior checks and file-scope checks. These percentages measure total input plus output, including cached input and remote compaction; they are not cache-hit percentages.

| Model | Measured reduction | Reached 42% |
| --- | ---: | :---: |
| gpt-6-astra | 19.78% | No |
| gpt-6-sol | 61.62% | Yes |
| gpt-6.1-sol | 26.34% | No |
| gpt-daybreak-blue-latest | 62.24% | Yes |
| gpt-5.6-terra | 24.14% | No |
| gpt-5.6-sol | 48.17% | Yes |
| gpt-5.6-luna | 54.29% | Yes |
| gpt-6-luna | 47.63% | Yes |
| gpt-5.5 | 54.33% | Yes |

Six of nine tested models reached 42%. The simple, unweighted mean is 44.28%; this does not establish 42% for every model or for everyday workloads. Each entry is one pair for its recorded policy, not a repeated-trial confidence estimate. Failed and superseded attempts remain in the local experiment ledger.

[Numeric receipts and validation evidence](evidence/2026-10-06/openai-reductions.json) contain no conversations, credentials or local paths. Earlier results based only on legacy Codex JSON snapshots are excluded because they can omit remote-compaction usage.

The bounded native tool catalogue and GPT-5.5 Code Mode policies require the verified Codex 0.160.1 runtime. Older or unknown versions retain the previous policy. A runtime inventory check retained all 564 MCP tools across 10 servers; this is an inventory check, not proof that every tool was exercised.

Grok has earlier real exports and is not revalidated by this OpenAI matrix. Claude has no authenticated paired proof in this matrix; Kimi lacks a supported correlated numeric collector. No percentage is invented for either.
