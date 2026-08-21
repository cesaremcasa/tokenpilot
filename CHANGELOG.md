# Changelog

All notable changes to TokenPilot are recorded here. Version numbers follow semantic versioning while the project remains pre-1.0 research software.

## 0.5.0 — 2026-08-21

- Launch the first public npm beta as `@cesaremcasa/tokenpilot`, with a three-command install path and explicit Cesar Augusto / Mycellium Lab authorship.
- Replace unqualified summary reduction language with evidence-aware output: preliminary variation, observed quality degradation, validated reduction, cache shift, or no comparable measurement.
- Preserve the JSON report and SQLite schema while updating every managed provider skill to paste the live evidence state unchanged.
- Reframe the existing research table as an experimental snapshot rather than a universal or formal quality-equivalence claim.
- Keep the zero-runtime-dependency package, deterministic tarball, SHA-256 manifest, CycloneDX SBOM, clean install smoke, and macOS/Linux Node 22 CI gates.

## 0.4.17 — 2026-08-18

- Deduplicate explicit provider treatment flags and value-taking options before adding validated policy arguments, preserving user argument order and values.
- Fail open to the original provider invocation when a known treatment argument is incomplete or ambiguous; prompt values that resemble flags remain opaque values.
- Add the exact Grok canary regression and provider-wide merge coverage without changing treatment policies or measurement formats.

## 0.4.16 — 2026-08-18

- Version the reproducible release candidate and keep the compiled CLI identity synchronized with package metadata.
- Carry forward the verified CI supply-chain controls from PR1: SHA-pinned Actions, least-privilege read-only permissions, lockfile verification, and a clean installation smoke.
- Carry forward the verified PR2 report safeguards: content-free observed outcome signals, fail-open quality handling, economy suppression for non-validated states, and neutral cache-shift reporting.
- Add deterministic npm tarball generation with a SHA-256 checksum, lock-derived CycloneDX SBOM, and a real tarball install/execute/uninstall smoke.

## 0.4.15 — 2026-08-17

- Add `grok-balanced-v6`, replacing the large native instruction prefix with a concise bounded coding contract.
- Disable subagents, cross-session memory, web search, and plan mode in Grok reduction sessions; headless runs expose only the general-purpose terminal tool.
- Keep TTY/TUI launches free of headless-only tool flags while applying the same minimal system prefix and bounded workflow.
- Validate the complete base and headless flag set before enabling the policy; unsupported Grok versions still fail open unchanged.
- Validate matched real-work cohorts at 3+3 sessions so a cache-aware result can be established without spending ten provider runs; all provider, task, policy, metric, price, and cache-shift guards remain required.

## 0.4.14 — 2026-08-17

- Correct Grok External OTEL cache accounting: the provider's `input` counter includes `cache_read`, so TokenPilot now subtracts cache reads before storing new input.
- Version corrected Grok OTLP rows as `grok-otlp-metrics-v2` and normalize historical v1 rows at report time without rewriting the telemetry database.
- Add live-correlated and legacy-report regressions for cache-aware Grok totals.
- Pin TypeScript's ambient type discovery to Node so duplicate cloud-synced `@types` directories cannot break local verification.

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
- Cache-shift, preliminary, and unmatched windows remain non-economic and show measured-use or neutral cache evidence instead of an invented reduction.

## 0.4.7 — 2026-08-17

- Disabled the Kimi REST/WebSocket bridge pending a content-free, child-authenticated measurement channel; Kimi now runs through its original CLI and remains envelope-only.
- Hardened managed-state validation against macOS ACL write grants and provider executable discovery against writable path ancestors.
- Accepted Apple's default `group:everyone deny delete` home ACL so a normal macOS install is not blocked.
- Continued to trust user-owned Homebrew `admin` group directories (`/opt/homebrew/lib`, `/opt/homebrew/bin`) while still refusing non-sticky world-writable or foreign group-writable ancestors.
- Added aggregate connection limits to the local Claude, Codex, and Grok telemetry receivers.
- Audited by Codex Security on 2026-08-15.

## 0.4.6 — 2026-08-15

- Published the project documentation under the Mycellium Lab identity and added the MIT License.
- Documented the first matched research snapshot for Claude, Codex, Grok, and Kimi.
- Changed the audited Kimi 0.36.x treatment from the unverified `low` label to the documented boolean `thinking: off` control (`kimi-balanced-v4`).
- Confirmed the advertised model/reasoning matrix on macOS and Linux test environments.
- Retained fail-open behavior, content-free storage, provider-local comparisons, and cache-shift detection.

## 0.4.5 — 2026-08-15

- Added measured Kimi 0.36.x text-print sessions through its authenticated local REST/WebSocket protocol.
- Released the Claude v7 latency-first treatment.

## Earlier research versions

Versions before 0.4.5 established the local installer, provider shims, SQLite data model, report skills, doctor, pricing snapshots, correlated Claude/Codex/Grok telemetry, and auditable cache-aware reporting.
