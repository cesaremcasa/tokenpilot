# Provider and platform compatibility

TokenPilot preserves the model selected by the user. It does not maintain a private model allowlist or silently replace the requested model. Provider-specific treatments are enabled only when the installed CLI advertises the complete required surface.

## Current platform support

| Platform | Installation | Runtime | CI | Status |
| --- | --- | --- | --- | --- |
| macOS with zsh | Supported | User LaunchAgent plus per-session launchers | `macos-latest`, Node 22 | Supported |
| Linux with bash | Supported | Per-session finalization; no permanent service | `ubuntu-latest`, Node 22 | Supported |
| VS Code integrated terminal | Uses the host shell configuration | Same as host | Covered by launcher/PATH tests | Supported on macOS/Linux |
| Windows native / PowerShell | Not released | Not implemented | Not present | Unsupported |
| WSL | Linux behavior may work | Linux behavior | Not in clean-machine acceptance | Experimental |

## Provider matrix

| Provider | Correlated measurement | Current treatment | Known limitation |
| --- | --- | --- | --- |
| Claude Code | Metrics-only local OTLP for sessions that publish `claude_code.token.usage`. | `claude-balanced-v7`; v6 fallback on older compatible CLIs. | Provider quota can reject a model before a complete metric arrives. Full web/MCP/agent tool surfaces require `deep`, `off`, or bypass. |
| OpenAI Codex | Metrics-only local OTLP for current interactive and `exec` sessions; older `exec` may expose only its final published total. | `codex-balanced-v2`. | A provider total and category counters are never mixed. |
| Grok Build | External OTEL v1 for supported TTY/TUI and headless sessions; explicit JSON single-turn fallback. | `grok-balanced-v5`; low reasoning with subagents and cross-session memory disabled. | Older or missing counters remain unavailable. API prompt-cache keys are never assumed for the CLI. Use `deep`, `off`, or bypass when subagents or memory are required. |
| Kimi Code CLI | No correlated measurement channel is currently enabled. | No TokenPilot treatment is injected. | Kimi runs through its original CLI and remains envelope-only pending a content-free, child-authenticated channel. |

## Advertised model/reasoning compatibility check

The first compatibility matrix was executed on August 15, 2026, using the models and effort levels advertised by the locally installed CLIs. These runs were classified as benchmarks and did not contribute to the reduction claims.

| Provider | Advertised matrix exercised | Result |
| --- | --- | --- |
| Claude 2.1.233 | `fable`, `opus`, `sonnet` × `low`, `medium`, `high`, `xhigh`, `max` = 15 combinations | 10 completed; 14/15 produced correlated counters. All five Fable requests were rejected by the provider's account limit. |
| Codex 0.146.1 | 33 combinations across `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark` | 33/33 completed and measured. |
| Grok Build 1.0.4 | `grok-4.6` with four advertised efforts and `grok-4.5` with three advertised efforts | 7/7 completed and measured. |
| Kimi 0.36.1 | `kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, and `k3-256k`, each in provider-default and audited `thinking: off` modes | 8/8 compatibility runs completed and measured. Named effort levels were not advertised. |

Compatibility means the launcher preserved the request and the supported measurement channel behaved correctly. It does not guarantee provider availability, account quota, equal model quality, or the same reduction percentage on every model.

The Kimi compatibility result is historical; the Kimi REST/WebSocket bridge is disabled pending a safe correlated measurement channel.

## Authentication

TokenPilot never creates a provider account or copies authentication between machines. Run the provider's normal login command as the target OS user. Login, logout, help, and version commands pass through without TokenPilot telemetry.

## Adding or updating support

A version string alone is insufficient. Adapter support requires:

1. a documented, exact-session numeric surface;
2. a bounded parser that discards content and unknown fields;
3. a complete local capability probe;
4. success, unavailable, privacy, and fail-open fixtures;
5. a real local smoke test; and
6. updated documentation describing what is and is not measured.

## Primary references

- [Claude Code monitoring and OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage)
- [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching)
- [OpenAI Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [xAI Grok Build CLI reference](https://docs.x.ai/build/cli/reference)
- [Kimi Code CLI command reference](https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html)
