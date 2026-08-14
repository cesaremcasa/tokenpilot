---
name: tokenpilot
description: Show the private local TokenPilot report for the last seven days. Use when the user asks about token use, cache effectiveness, measured savings, or experiment quality for Claude, Codex, Grok, or Kimi.
metadata:
  tokenpilot-managed-skill: "v1"
---

# TokenPilot report

Run exactly this read-only command:

```sh
tokenpilot report --format md
```

Present its result without inspecting the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.

## Reporting rules

- State the measurement coverage before interpreting an optimization result.
- Treat a provider with no measured sessions as unavailable; do not estimate tokens.
- Compare only rows from the same provider and task type. Never sum or compare raw token totals across providers.
- Call a negative change in token pressure a measured reduction only when the report marks the comparison ready. Otherwise call it preliminary.
- Mention cache reads separately from newly created context; they have different meanings.
- If the command is missing or fails, say so plainly and give no substitute token estimate.
