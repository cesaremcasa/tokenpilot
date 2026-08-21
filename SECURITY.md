# Security policy

TokenPilot is a local measurement and optimization tool created by Cesar Augusto / Mycellium Lab. Its primary security boundary is simple: it must remain outside provider authentication and must never retain model or developer content.

## Supported versions

Security fixes are applied to the latest release on `main`. Older research builds may not receive backports. Include the TokenPilot version, operating system, Node.js version, and affected provider CLI version in a report.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** / Security Advisory flow for this repository. If private reporting is unavailable, open a public issue containing only a request for a private maintainer contact. Do not include exploit details, credentials, prompts, source code, paths, account identifiers, databases, or raw provider output in a public issue.

The maintainers will acknowledge a complete report, reproduce it with synthetic data, assess affected versions, and coordinate a fix before public disclosure when possible.

## Data that must never persist or be exported

- API keys, OAuth tokens, cookies, passwords, account emails, or provider session secrets;
- prompts, responses, reasoning text, source code, file paths, tool results, shell commands, or command-line arguments;
- raw provider session logs, histories, transcripts, JSONL files, or unreviewed exports; and
- company identifiers or telemetry copied from an unapproved environment.

Claude's metrics exporter may include provider-supplied resource attributes transiently in process memory. TokenPilot discards every resource attribute before storage and accepts only the documented numeric token metric.

## Allowed local fields

- provider and CLI version;
- opaque run ID, timestamps, duration, exit status, mode, policy, and collection status;
- optional content-free task category and outcome; and
- numeric token, cache, request, retry, compaction, model-call, and provider-total counters.

## Runtime controls

- `TOKENPILOT_BYPASS=1 <provider>` opens the original provider CLI and records nothing.
- `tokenpilot mode off` disables treatment and measurement for future sessions.
- If optional configuration, telemetry, policy probing, or storage fails, the original provider CLI opens without the treatment.
- Authentication, logout, help, and version commands pass through without telemetry.

## Installation and executable boundary

- Production commands ignore environment-controlled state-root overrides.
- Installation and removal refuse unsafe directories, symlinks, foreign launchers, and modified managed shell blocks.
- Provider executables are resolved only as regular executables outside TokenPilot's launcher directory, and their containing directory must not be group- or world-writable.
- TokenPilot runs as the current user and never requires root.
- Raw telemetry remains under the current user's private local state directory.
- Release tarballs must be verified with their adjacent SHA-256 manifest before installation; the accompanying CycloneDX SBOM is derived from the committed lockfile and contains no host paths or generated timestamps.

## Adapter requirements

A measurement adapter must correlate documented numeric counters to the exact wrapped session. TokenPilot does not scrape terminal UIs, ambient provider logs, history folders, transcripts, timestamps, or provider cache files. Missing or unverified counters are marked unavailable.

An optimization adapter must be versioned, session-scoped, verified against the installed CLI's documented surface, reversible, and fail-open. API-only cache controls must never be assumed to work in a provider CLI.

## Enterprise boundary

The MIT-licensed source may be reviewed and deployed by an organization, but production adoption still requires the organization's security, legal, privacy, and data-retention approval. Company telemetry must remain in company-approved local or company-owned storage. See [Enterprise adoption](docs/ENTERPRISE.md).
