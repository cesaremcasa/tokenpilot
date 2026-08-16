---
name: tokenpilot
description: Show the privacy-preserving local Kimi TokenPilot report for the last seven days. Use when the user asks about Kimi token use, measured reduction, latency, coverage, or experiment quality.
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
- Audited Kimi 0.36.x text-print sessions may use the authenticated local REST/WebSocket numeric channel. Interactive, unsupported, timed-out, or uncorrelated sessions remain unavailable; never estimate them.
- The command is already limited to Kimi. Never add another provider or combine provider totals.
- Call a reduction only when the summary says `validated reduction`.
- Treat limited measurement, a missing comparable base, cache-shift, and preliminary signals as not validated.
- Keep new input, cache reads, cache creation, pressure, and complete total distinct.
- If the command is missing or fails, say so plainly and give no substitute token estimate.
