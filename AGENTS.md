# TokenPilot session evidence invariant

- Default CLI and skills show the current session's verified cache reuse and uncached input percentages, never raw token totals.
- Inside a wrapped agent use its opaque run ID; outside use the latest session in the requested window. Never replace missing data with an older measurement.
- Cached input divided by verified total input defines reuse; exclude output and do not count cache creation as a cache hit. Reject missing, inconsistent or mixed-source metrics.
- Cache reuse is distinct from A/B reduction. Preserve historical experiment data and rejected increases; do not present them as current-session cache percentages.
- Keep providers separate and make CLI/skills identical. Preserve native tools, memory, agents, web and apps; use focused validation, never repeated audits.
