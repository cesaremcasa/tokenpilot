---
name: tokenpilot
description: Show the private local Kimi TokenPilot report for the last seven days. Use when the user asks about Kimi token use, measurement coverage, latency, or experiment quality.
---

<!-- tokenpilot-managed-skill:v2 kimi -->

# TokenPilot report

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider kimi --view summary --format md
```

Return the command's Markdown verbatim. Do not add another heading, table, summary, calculation, or interpretation. Do not inspect the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.

## Reporting rules

- State measurement coverage first.
- Kimi is envelope-only until a documented correlated numeric channel exists; do not estimate tokens or savings.
- The command is already limited to Kimi. Never add another provider or combine provider totals.
- If the command is missing or fails, say so plainly and give no substitute token estimate.
