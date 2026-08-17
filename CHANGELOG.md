# Changelog

All notable changes to TokenPilot are recorded here. Version numbers follow semantic versioning while the project remains pre-1.0 research software.

## Unreleased

## 0.4.7 — 2026-08-17

- Disabled the Kimi REST/WebSocket bridge pending a content-free, child-authenticated measurement channel; Kimi now runs through its original CLI and remains envelope-only.
- Hardened managed-state validation against macOS ACL write grants and provider executable discovery against writable path ancestors.
- Accepted Apple's default `group:everyone deny delete` home ACL so a normal macOS install is not blocked.
- Continued to trust user-owned Homebrew `admin` group directories (`/opt/homebrew/lib`, `/opt/homebrew/bin`) while still refusing world-writable or foreign group-writable ancestors.
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
