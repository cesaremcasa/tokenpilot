# Agent skills

| Host | Invocation | Installation scope |
| --- | --- | --- |
| Codex | `$tokenpilot` or `/skills` → TokenPilot | `~/.agents/skills/tokenpilot/SKILL.md`; shared by models and new sessions |
| Grok Build | `/tokenpilot` or `/skills` | `~/.grok/skills/tokenpilot/SKILL.md`; shared by models and new sessions |
| Claude Code | `/tokenpilot` | `~/.claude/skills/tokenpilot/SKILL.md`; authentication required for live validation |
| Grok Bot | Type `/` and select the saved TokenPilot private skill | Shared cloud private-skills library; separate from local Grok Build |

Run `tokenpilot install` to install or update owned local skills. Third-party skills are preserved. Refresh the skills menu or start a new session after updating.

With a work task, the skill uses bounded reads and grouped validation while retaining native capabilities. Without a work task, it runs the provider-scoped report and returns verified cache percentages. Cache reuse is not measured A/B reduction, and historical results never substitute for current-session telemetry.

For Grok Bot, use [the packaged skill](../integrations/grok-bot/tokenpilot/SKILL.md). Save it as a private skill named TokenPilot, verify its presence in the `/` menu, then test it on a read-only task. A local file or a Grok Build installation alone does not prove cloud installation. Parent-Bot reduction remains unavailable until official complete numeric receipts and equivalent paired results exist.

Measured reductions: [OpenAI](REAL_RESULTS_2026-10-06.md) and [Grok Build](GROK_RESULTS_2026-10-06.md). Invocation guidance: [OpenAI](https://developers.openai.com/blog/eval-skills) and [Grok Bot](https://docs.x.ai/grok-bot/skills-routines-and-automations).
