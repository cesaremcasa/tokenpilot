# Security and privacy boundary

TokenPilot is a local measurement tool. It must remain outside the provider authentication path and outside model request/response traffic.

## Never collect

- API keys, OAuth tokens, cookies, passwords, or account emails;
- prompts, replies, model reasoning text, source code, file paths, tool results, shell commands, or command-line arguments;
- raw provider session logs or any unreviewed export.

## Allowed local fields

- provider and CLI version;
- pseudonymous run ID, timestamps, local exit status, mode, and optional task category/outcome;
- numeric token, cache, request, retry, compaction, and duration counters.

## Fail-open behavior

If configuration, telemetry storage, or collection fails, the launcher starts the original provider CLI without optimization. `TOKENPILOT_BYPASS=1` bypasses the launcher for one command and records nothing.

## Enterprise boundary

No company account, account identifier, prompt, code, or metric may be copied to this personal repository. A company pilot requires a company-owned codebase, approved storage, Security review, and user-visible opt-in/rollback controls.
