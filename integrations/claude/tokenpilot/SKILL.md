---
name: tokenpilot
description: Show verified cache percentages for the current claude session, or the latest recent session; never substitute experiment history.
---

<!-- tokenpilot-managed-skill:v7 claude -->

# TokenPilot session cache

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider claude --view summary --format md
```

Print the command stdout unchanged and nothing else.

- The primary result is the current session's cache percentage and uncached input percentage.
- In a wrapped agent, the CLI uses its opaque run context; otherwise it selects the latest recent session with its date.
- Never replace missing metrics with zero, older sessions, benchmark percentages, or documentation snapshots.
- Cache reuse is not a claim of reduction caused by TokenPilot. Never show raw token counts or combine providers.
- Do not read databases, provider logs, prompts, transcripts, account details, or environment variables directly; the CLI handles session context.
- Preserve every unavailable state. If the command fails, say `TokenPilot command failed. Session cache percentage unavailable.`
