# Changelog

All notable changes to TokenPilot are recorded here. Version numbers follow semantic versioning while the project remains pre-1.0 research software.

## 0.4.13 — 2026-08-17

- Keep the concise scoreboard copy unchanged while showing measured usage instead of an economy claim for preliminary, incomparable, or limited cohorts.
- Add the versioned `grok-balanced-v5` treatment: low reasoning, verbatim prompting, concise context rules, and session-scoped subagent and cross-session-memory disabling.
- Preserve Grok's External OTEL delta accounting; growing per-call context is real usage and is never deduplicated as if it were a cumulative snapshot.

## 0.4.12 — 2026-08-17

- Remove Supervisor SSH deploy from public CI; public-readiness hygiene.
- CI now runs only the `verify` job (test, check, build) on `ubuntu-latest` and `macos-latest`.
- Local updates stay on `scripts/update.sh` and `scripts/install-auto-update.sh`. `update.sh` refuses to run off `main` and uses `TOKENPILOT_GIT_SSH_KEY` only when set.

## 0.4.11 — 2026-08-17

- Show measured token totals in the 24-hour scoreboard when a session was recorded but no observe/treatment pair exists yet.
- Added `scripts/update.sh` so a machine can fast-forward from `origin/main` and reinstall without touching local telemetry.
- A local poller (`scripts/install-auto-update.sh`) covers machines that pull `main` on a timer.

## 0.4.10 — 2026-08-17

- New default mode `reduce`: apply the token-reduction treatment on every Claude, Codex, and Grok session.
- Keep `balanced` as an opt-in 50/50 experiment. `observe` is no longer part of the default path.

## 0.4.9 — 2026-08-17

- Count in-progress Grok TTY/TUI sessions that already published External OTEL counters, instead of waiting for the process to exit.
- Show preliminary expected/used token totals on the scoreboard so a live Grok pair is not hidden behind `sem medição ainda`.
- Keep the Grok loopback receiver open for a short flush window when a session exits before the first metric arrives.

## 0.4.8 — 2026-08-17

- Replaced the skill summary with a short scoreboard: rolling last 24 hours, then last 7 days.
- The 24-hour window always counts backward from now. It is not a calendar day.
- The scoreboard shows expected tokens, used tokens, and the savings percentage. It omits USD, latency, and policy jargon.
- Cache-shift, preliminary, and unmatched windows print `sem medição ainda` or `0% a menos` instead of an invented reduction.

## 0.4.7 — 2026-08-17

- Disabled the Kimi REST/WebSocket bridge pending a content-free, child-authenticated measurement channel; Kimi now runs through its original CLI and remains envelope-only.
- Hardened managed-state validation against macOS ACL write grants and provider executable discovery against writable path ancestors.
- Accepted Apple's default `group:everyone deny delete` home ACL so a normal macOS install is not blocked.
- Continued to trust user-owned Homebrew `admin` group directories (`/opt/homebrew/lib`, `/opt/homebrew/bin`) while still refusing non-sticky world-writable or foreign group-writable ancestors.
- Added aggregate connection limits to the local Claude, Codex, and Grok telemetry receivers.
- Audited by Codex Security on 2026-08-15.

## 0.4.6 — 2026-08-15

- Published the project documentation under the Mycellium Lab identity and added the MIT License.
- Documented the first validated research round for Claude, Codex, Grok, and Kimi.
- Changed the audited Kimi 0.36.x treatment from the unverified `low` label to the documented boolean `thinking: off` control (`kimi-balanced-v4`).
- Confirmed the advertised model/reasoning matrix on macOS and Linux test environments.
- Retained fail-open behavior, content-free storage, provider-local comparisons, and cache-shift detection.

## 0.4.5 — 2026-08-15

- Added measured Kimi 0.36.x text-print sessions through its authenticated local REST/WebSocket protocol.
- Released the Claude v7 latency-first treatment.

## Earlier research versions

Versions before 0.4.5 established the local installer, provider shims, SQLite data model, report skills, doctor, pricing snapshots, correlated Claude/Codex/Grok telemetry, and auditable cache-aware reporting.
