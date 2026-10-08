---
name: tokenpilot
description: Work with bounded context and report verified codex session cache percentages; keep measured A/B reductions separate.
---

<!-- tokenpilot-managed-skill:v8 codex -->

# TokenPilot

For a supplied work task, preserve every native capability and safety rule. Search and read only relevant ranges, batch independent inspections and related edits, run required checks together when safe, fix observed failures only, and stop after verification. This workflow does not itself prove a savings percentage.

For a metrics-only request, run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider codex --view summary --format md
```

For metrics-only requests, print the command stdout unchanged and nothing else. For work tasks, complete the requested work and report measured cache data only when requested.

- The primary result is the current session's cache percentage and uncached input percentage.
- In a wrapped agent, the CLI uses its opaque run context; otherwise it selects the latest recent session with its date.
- Never replace missing metrics with zero, older sessions, benchmark percentages, or documentation snapshots.
- Cache reuse is not a claim of reduction caused by TokenPilot. Never show raw token counts or combine providers.
- Do not read databases, provider logs, prompts, transcripts, account details, or environment variables directly; the CLI handles session context.
- Preserve every unavailable state. If the command fails, say `TokenPilot command failed. Session cache percentage unavailable.`

Measured A/B reductions and limitations: https://github.com/cesaremcasa/tokenpilot/blob/main/docs/REAL_RESULTS_2026-10-06.md and https://github.com/cesaremcasa/tokenpilot/blob/main/docs/GROK_RESULTS_2026-10-06.md. Never use those historical percentages as the current session result.
