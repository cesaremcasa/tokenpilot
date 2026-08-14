# Security and privacy boundary

TokenPilot is a local measurement tool. It must remain outside the provider authentication path and outside model request/response traffic.

## Never persist or export

- API keys, OAuth tokens, cookies, passwords, or account emails;
- prompts, replies, model reasoning text, source code, file paths, tool results, shell commands, or command-line arguments;
- raw provider session logs or any unreviewed export.

The personal Claude metrics receiver can transiently receive provider-supplied
resource attributes in process memory. It immediately discards every resource
attribute and writes only the allowed numeric counters below. It never logs,
stores, or exports those transient fields.

## Allowed local fields

- provider and CLI version;
- pseudonymous run ID, timestamps, local exit status, mode, and optional task category/outcome;
- numeric token, cache, request, retry, compaction, and duration counters.

## Fail-open behavior

If configuration, telemetry storage, or collection fails, the launcher starts the original provider CLI without optimization. `TOKENPILOT_BYPASS=1` bypasses the launcher for one command and records nothing.

## Installation and executable boundary

- The installed CLI ignores `HOME` and `TOKENPILOT_*` state-directory overrides. Test-only overrides are unavailable to normal commands.
- Installation and removal refuse to overwrite or delete a non-TokenPilot shim, LaunchAgent, or shell startup file symlink.
- The launcher never loads a provider executable path from configuration. It accepts only a regular executable outside its own shim directory, with a containing directory that is not group- or world-writable.
- V0.1 does not scan ambient provider logs. A provider-specific adapter must prove a documented run correlation before it can write numeric usage records.

## Enterprise boundary

No company account identifier, prompt, code, or metric may be copied to this personal repository. The personal deployment records only its content-free local session envelope and never uploads it; use it only with accounts and data approved for that personal experiment. A company pilot requires a company-owned codebase, approved storage, Security review, and user-visible opt-in/rollback controls.
