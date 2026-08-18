---
name: tokenpilot
description: Show the latest locally measured cache-aware TokenPilot token-reduction percentage for Grok. Use for TokenPilot reports, token reduction, cache-aware reduction, or savings checks; never substitute documentation snapshots or raw window totals.
---

<!-- tokenpilot-managed-skill:v5 grok -->

# TokenPilot cache-aware reduction

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider grok --view summary --format md
```

Print the command stdout and nothing else.

## Hard rules

- If stdout starts with `TokenPilot ·`, that is the live report. Paste it unchanged.
- The primary and required result is `redução cache-aware` followed by the latest measured percentage.
- The command searches all local history for the most recent comparable measurement. Never replace it with 24-hour or 7-day emptiness, raw tokens used, USD, latency, quality labels, or policy jargon.
- `% a menos`, `0% a menos`, and `% a mais` are valid live measured outcomes. Never turn an increase into a reduction.
- Never use numbers from README, CHANGELOG, or `docs/RESULTS.md`.
- Do not read the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.
- Never add another provider or combine totals.
- If the command is missing, fails, or does not emit `redução cache-aware`, say `TokenPilot command failed. No cache-aware reduction.`
