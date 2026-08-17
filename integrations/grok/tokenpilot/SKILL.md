---
name: tokenpilot
description: Run the local Grok TokenPilot scoreboard command and paste its stdout. Never use README or docs/RESULTS.md numbers.
---

<!-- tokenpilot-managed-skill:v4 grok -->

# TokenPilot report

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider grok --view summary --format md
```

Print the command stdout and nothing else.

## Hard rules

- If stdout starts with `TokenPilot ·`, that is the live report. Paste it unchanged.
- `sem medição ainda` and `0% a menos` are valid live answers. Do not replace them.
- Never print `TokenPilot — Grok — last seven days`, `Window starts:`, `validated median reduction`, `USD:`, or `API-equivalent`.
- Never use numbers from README, CHANGELOG, or `docs/RESULTS.md`. The 42.6% Grok research row is a historical snapshot, not this machine.
- Do not read the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.
- Never add another provider or combine totals.
- If the command is missing or fails, say `TokenPilot command failed. No token estimate.`
