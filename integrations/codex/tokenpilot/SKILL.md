---
name: tokenpilot
description: Show the privacy-preserving local Codex TokenPilot scoreboard for the rolling last 24 hours and last seven days. Use when the user asks about Codex token use, measured reduction, coverage, or how many tokens were expected versus used.
---

<!-- tokenpilot-managed-skill:v3 codex -->

# TokenPilot report

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider codex --view summary --format md
```

Return the command's Markdown verbatim. Do not add another heading, table, summary, calculation, or interpretation. Do not inspect the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.

## Reporting rules

- The summary already uses a rolling last-24-hours window (from now backward, not a calendar day) and the last 7 days.
- Repeat the printed percentage and token counts. Never invent a missing 24-hour or 7-day figure.
- Treat `sem medição ainda` and `0% a menos` as no savings claim.
- The command is already limited to Codex. Never add another provider or combine provider totals.
- Do not mention USD, bills, or prices.
- If the command is missing or fails, say so plainly and give no substitute token estimate.
