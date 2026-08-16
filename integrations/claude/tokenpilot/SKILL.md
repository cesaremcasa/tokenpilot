---
name: tokenpilot
description: Show the privacy-preserving local Claude TokenPilot report for the last seven days. Use when the user asks about Claude token use, measured reduction, latency, cache effectiveness, coverage, or experiment quality.
---

<!-- tokenpilot-managed-skill:v2 claude -->

# TokenPilot report

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider claude --view summary --format md
```

Return the command's Markdown verbatim. Do not add another heading, table, summary, calculation, or interpretation. Do not inspect the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.

## Reporting rules

- State the measurement coverage before interpreting an optimization result.
- Treat no measured sessions as unavailable; do not estimate tokens.
- The command is already limited to Claude. Never add another provider or combine provider totals.
- Call a reduction only when the summary says `validated reduction`.
- Treat `cache-shift`, limited measurement, and a missing comparable base as no estimate: never infer savings from them.
- Keep new input, cache reads, cache creation, pressure, and complete total distinct.
- If the command is missing or fails, say so plainly and give no substitute token estimate.
