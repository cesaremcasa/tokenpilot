---
name: tokenpilot
description: Show the latest locally measured cache-aware TokenPilot result and evidence state for Codex. Use for TokenPilot reports, token reduction, cache-aware variation, or savings checks; never substitute documentation snapshots or raw window totals.
---

<!-- tokenpilot-managed-skill:v6 codex -->

# TokenPilot cache-aware evidence

Run exactly this read-only command:

```sh
{{TOKENPILOT_COMMAND}} report --provider codex --view summary --format md
```

Print the command stdout and nothing else.

## Hard rules

- If stdout starts with `TokenPilot ·`, that is the live report. Paste it unchanged.
- The primary and required result is the live cache-aware variation and its evidence state. Only formal evidence may use `redução cache-aware validada`.
- The command searches all local history for the most recent comparable measurement. Never replace it with 24-hour or 7-day emptiness, raw tokens used, USD, or policy jargon.
- `% a menos`, `0% a menos`, and `% a mais` are valid live measured outcomes. Never turn an increase into a reduction.
- `preliminar`, `qualidade observada degradada`, `cache-shift`, and `sem comparação cache-aware medida` are valid live evidence states. Preserve them unchanged.
- Never use numbers from README, CHANGELOG, or `docs/RESULTS.md`.
- Do not read the SQLite database, provider logs, prompts, transcripts, project files, account details, or environment variables.
- Never add another provider or combine totals.
- If the command is missing, fails, or does not emit a cache-aware result, say `TokenPilot command failed. No cache-aware result.`
