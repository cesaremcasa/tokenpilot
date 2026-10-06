import { spawnSync } from "node:child_process";
import type { Provider, RunMode } from "./types.js";

export function appliesReductionPolicy(mode: RunMode): boolean {
  return mode === "reduce" || mode === "balanced";
}

/**
 * This fixed instruction is TokenPilot product code, not user or provider
 * content. Keeping it short and byte-stable makes its own cache cost bounded
 * while targeting repeated reads, verbose intermediate output, and unnecessary
 * tool turns. It is never stored in telemetry.
 */
export const TOKEN_EFFICIENCY_INSTRUCTION = "Minimize token use without reducing correctness. Inspect narrowly, batch independent reads, avoid rereading unchanged data or repeating context, keep intermediate explanations concise, and stop after the requested result is verified. Do not skip necessary validation or change requested scope.";

/** Codex v4 keeps native context-compaction defaults and the full capability surface. */
export const CODEX_TOKEN_EFFICIENCY_INSTRUCTION = `Preserve every available capability. ${TOKEN_EFFICIENCY_INSTRUCTION}`;
const CODEX_V3_TOKEN_EFFICIENCY_INSTRUCTION = "Preserve every available capability. Minimize total tokens without reducing correctness. For read-only repository work, use at most three batched shell calls: locate evidence, inspect only required ranges, then verify every exact value and citation with nl -ba. Never cite a line not present in numbered output. Answer immediately after verification. For edits, batch inspection, perform the edit, run one sufficient verification, then stop. Do not narrate routine steps, reread unchanged data, repeat context, or add unrequested work.";
export const CODEX_V7_TOKEN_EFFICIENCY_INSTRUCTION = "Preserve every available capability and requested scope. Inspect relevant source sections in one batched search/read; make the smallest complete edit. Run every required check together in one shell invocation using `&&` so a failure is visible. If a check fails, fix only its observed cause and repeat the affected check. Stop when the requested work and all checks pass; do not reread unchanged sections or repeat context.";
export const CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION = "Preserve all capabilities, correctness and requested scope. Minimize context replay: batch independent reads in one call, search before reading, and print only relevant bounded ranges. Do not dump whole files or narrate routine actions. After inspection, batch related edits and every required check in one call with failure-visible commands. Fix observed failures only, repeat affected checks, then stop with a concise result. If an output is truncated, fetch only the missing range needed for correctness.";
export const CODEX_V13_TOKEN_EFFICIENCY_INSTRUCTION = `${CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION} For a small edit, aim for one inspection round and one edit-and-check round; use more only when required by missing evidence or a failed check. Choose a foreground wait appropriate to command duration; avoid repeatedly polling a running command.`;
const CODEX_V20_TOKEN_EFFICIENCY_INSTRUCTION = `${CODEX_V13_TOKEN_EFFICIENCY_INSTRUCTION} Prefer available Code Mode to batch native tool calls. After inspection, invoke apply_patch and all required verification sequentially in a single Code Mode call, awaiting each dependency. Set yield_time_ms=30000 for checks. Preserve all native tools and requirements; use direct tools if needed.`;

/**
 * Claude's latency policy is deliberately shorter than the cross-provider
 * instruction above. It tells Claude to batch independent work and perform a
 * single sufficient verification pass, while the CLI flags below remove
 * optional browser startup and keep dynamic machine data out of the reusable
 * system-prompt prefix. The text is fixed product code and is never persisted.
 */
export const CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION = "Finish correctly with minimal latency and tokens: inspect narrowly, batch independent reads, avoid rereading or narrating, verify once, and stop. Do not skip required validation or change scope.";

/**
 * Claude's default tool catalog is useful but expensive to send on every
 * request. Balanced v6 keeps the local coding primitives required to inspect,
 * search, create, and edit a repository while leaving the full native catalog
 * available through `deep` or the immediate bypass. The value is fixed product
 * code and is never derived from a project or stored in telemetry.
 */
export const CLAUDE_CORE_TOOLS = "Bash,Edit,Read,Write,Grep,Glob";

/**
 * Grok v8 keeps the provider's complete tool and feature surface while using
 * low reasoning effort and a concise, bounded coding contract.
 */
export const GROK_TOKEN_EFFICIENCY_INSTRUCTION = "Preserve every native tool, memory, agent, web/app capability, safety rule and task requirement. Minimize repeated context: locate the relevant symbol with a bounded search, read only the required source and test ranges, and batch independent inspections. Make the smallest complete edit; reproduce a focused regression before fixing when practical. Group related edits and all required checks in a failure-visible command. Wait for checks to finish in the foreground when supported; fix only observed failures, repeat affected checks, and stop with a concise result. Retrieve any missing evidence if output was truncated.";

/** A plan never contains credentials or user-supplied command arguments. */
export interface OptimizationPlan {
  args: string[];
  /** Extra validated flags used only by provider headless modes. */
  headlessArgs?: string[];
  applied: boolean;
  profile?: string;
  summary?: string;
  unavailableReason?: string;
}

export interface TreatmentMergeResult {
  args: string[];
  applied: boolean;
  deduplicated: boolean;
  conflicts: string[];
  omitted: string[];
  reason?: string;
}

interface TreatmentArgumentSchema {
  provider: Provider;
  key: string;
  flags: string[];
  takesValue: boolean;
}

interface ParsedTreatmentArgument {
  schema: TreatmentArgumentSchema;
  value?: string;
  tokens: string[];
  ambiguous: boolean;
}

const TREATMENT_ARGUMENT_SCHEMAS: TreatmentArgumentSchema[] = [
  { provider: "claude", key: "effort", flags: ["--effort"], takesValue: true },
  { provider: "claude", key: "tools", flags: ["--tools"], takesValue: true },
  { provider: "claude", key: "append-system-prompt", flags: ["--append-system-prompt"], takesValue: true },
  { provider: "claude", key: "no-chrome", flags: ["--no-chrome"], takesValue: false },
  { provider: "claude", key: "exclude-dynamic-system-prompt-sections", flags: ["--exclude-dynamic-system-prompt-sections"], takesValue: false },
  { provider: "claude", key: "prompt", flags: ["-p", "--print", "--prompt"], takesValue: true },
  { provider: "claude", key: "model", flags: ["--model"], takesValue: true },
  { provider: "claude", key: "output-format", flags: ["--output-format"], takesValue: true },
  { provider: "claude", key: "max-turns", flags: ["--max-turns"], takesValue: true },
  { provider: "claude", key: "settings", flags: ["--settings"], takesValue: true },
  { provider: "claude", key: "add-dir", flags: ["--add-dir"], takesValue: true },
  { provider: "claude", key: "permission-mode", flags: ["--permission-mode"], takesValue: true },
  { provider: "codex", key: "config", flags: ["--config", "-c"], takesValue: true },
  { provider: "codex", key: "model", flags: ["--model", "-m"], takesValue: true },
  { provider: "codex", key: "profile", flags: ["-p", "--profile"], takesValue: true },
  { provider: "codex", key: "sandbox", flags: ["-s", "--sandbox"], takesValue: true },
  { provider: "codex", key: "ask-for-approval", flags: ["--ask-for-approval"], takesValue: true },
  { provider: "codex", key: "ephemeral", flags: ["--ephemeral"], takesValue: false },
  { provider: "codex", key: "skip-git-repo-check", flags: ["--skip-git-repo-check"], takesValue: false },
  { provider: "codex", key: "output-last-message", flags: ["-o", "--output-last-message"], takesValue: true },
  { provider: "codex", key: "output-schema", flags: ["--output-schema"], takesValue: true },
  { provider: "codex", key: "color", flags: ["--color"], takesValue: true },
  { provider: "codex", key: "cd", flags: ["--cd", "-C"], takesValue: true },
  { provider: "codex", key: "image", flags: ["-i", "--image"], takesValue: true },
  { provider: "codex", key: "max-turns", flags: ["--max-turns"], takesValue: true },
  { provider: "codex", key: "output-format", flags: ["--output-format"], takesValue: true },
  { provider: "codex", key: "json", flags: ["--json"], takesValue: false },
  { provider: "grok", key: "effort", flags: ["--effort", "--reasoning-effort"], takesValue: true },
  { provider: "grok", key: "rules", flags: ["--rules"], takesValue: true },
  { provider: "grok", key: "tools", flags: ["--tools"], takesValue: true },
  { provider: "grok", key: "system-prompt-override", flags: ["--system-prompt-override"], takesValue: true },
  { provider: "grok", key: "verbatim", flags: ["--verbatim"], takesValue: false },
  { provider: "grok", key: "no-subagents", flags: ["--no-subagents"], takesValue: false },
  { provider: "grok", key: "no-memory", flags: ["--no-memory"], takesValue: false },
  { provider: "grok", key: "disable-web-search", flags: ["--disable-web-search"], takesValue: false },
  { provider: "grok", key: "no-plan", flags: ["--no-plan"], takesValue: false },
  { provider: "grok", key: "single", flags: ["--single", "-p", "--prompt"], takesValue: true },
  { provider: "grok", key: "prompt-file", flags: ["--prompt-file"], takesValue: true },
  { provider: "grok", key: "prompt-json", flags: ["--prompt-json"], takesValue: true },
  { provider: "grok", key: "json-schema", flags: ["--json-schema"], takesValue: true },
  { provider: "grok", key: "model", flags: ["--model"], takesValue: true },
  { provider: "grok", key: "cwd", flags: ["--cwd"], takesValue: true },
  { provider: "grok", key: "max-turns", flags: ["--max-turns"], takesValue: true },
  { provider: "grok", key: "output-format", flags: ["--output-format"], takesValue: true }
];

function schemasFor(provider: Provider): TreatmentArgumentSchema[] {
  return TREATMENT_ARGUMENT_SCHEMAS.filter((schema) => schema.provider === provider);
}

/** Select a policy only from one unambiguous native model selector in argv. */
export function codexModelFromArgs(args: readonly string[]): string | undefined {
  const schemas = [
    ...schemasFor("codex"),
    { provider: "codex" as const, key: "enable", flags: ["--enable", "--disable"], takesValue: true },
    { provider: "codex" as const, key: "local-provider", flags: ["--local-provider"], takesValue: true },
    { provider: "codex" as const, key: "other-value", flags: ["--add-dir", "--thread-source"], takesValue: true },
    { provider: "codex" as const, key: "oss", flags: ["--oss"], takesValue: false },
    { provider: "codex" as const, key: "strict-config", flags: ["--strict-config", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--worktree", "--ignore-user-config", "--ignore-rules"], takesValue: false }
  ];
  let selectedModel: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") return selectedModel;
    if (token === "exec") {
      if (index === 0 || selectedModel !== undefined) continue;
      return undefined;
    }

    const match = argumentMatch(token, schemas);
    if (!match) {
      if (token.startsWith("-")) return undefined;
      const hasTrailingModelOption = args.slice(index + 1).some((argument) => argumentMatch(argument, schemas)?.schema.key === "model");
      if (hasTrailingModelOption) return undefined;
      return selectedModel;
    }

    if (match.schema.key === "model") {
      const value = match.inlineValue ?? args[index + 1];
      if (!value?.trim() || value.startsWith("-") || selectedModel !== undefined) return undefined;
      selectedModel = value;
      if (match.inlineValue === undefined) index += 1;
      continue;
    }

    if (match.schema.key === "oss" || match.schema.key === "local-provider") return undefined;

    if (!match.schema.takesValue) {
      if (match.inlineValue !== undefined) return undefined;
      continue;
    }

    if (match.inlineValue === undefined) {
      const value = args[index + 1];
      if (value === undefined || value === "--") return undefined;
      if (match.schema.key === "config") {
        const key = value.slice(0, value.indexOf("="));
        if (key === "model_provider" || key.startsWith("model_providers.")) return undefined;
      }
      index += 1;
    } else if (match.schema.key === "config") {
      const key = match.inlineValue.slice(0, match.inlineValue.indexOf("="));
      if (key === "model_provider" || key.startsWith("model_providers.")) return undefined;
    }
  }

  return selectedModel;
}

function argumentMatch(token: string, schemas: TreatmentArgumentSchema[]): { schema: TreatmentArgumentSchema; inlineValue?: string } | undefined {
  for (const schema of schemas) {
    for (const flag of schema.flags) {
      if (token === flag) return { schema };
      if (token.startsWith(`${flag}=`)) return { schema, inlineValue: token.slice(flag.length + 1) };
    }
  }
  return undefined;
}

function looksLikeTreatmentFlag(token: string, schemas: TreatmentArgumentSchema[]): boolean {
  return argumentMatch(token, schemas) !== undefined || schemas.some((schema) => schema.flags.some((flag) => token.startsWith(`${flag}=`)));
}

function unknownOptionMayConsumeTreatmentFlag(token: string, next: string | undefined, schemas: TreatmentArgumentSchema[]): boolean {
  if (!token.startsWith("-")) return false;
  const separator = token.indexOf("=");
  if (separator > 0 && looksLikeTreatmentFlag(token.slice(separator + 1), schemas)) return true;
  return next !== undefined && next !== "--" && looksLikeTreatmentFlag(next, schemas);
}

function parseTreatmentArguments(args: string[], schemas: TreatmentArgumentSchema[], strict: boolean): ParsedTreatmentArgument[] {
  const parsed: ParsedTreatmentArgument[] = [];
  for (let index = 0; index < args.length;) {
    const token = args[index];
    if (token === "--") break;
    const match = argumentMatch(token, schemas);
    if (!match) {
      if (unknownOptionMayConsumeTreatmentFlag(token, args[index + 1], schemas)) {
        if (strict) throw new Error(`Ambiguous unknown option arity: ${token}`);
        parsed.push({ schema: schemas[0] ?? { provider: "grok", key: "ambiguous", flags: [], takesValue: false }, tokens: args[index + 1] ? [token, args[index + 1]] : [token], ambiguous: true });
        index += args[index + 1] ? 2 : 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (!match.schema.takesValue) {
      parsed.push({ schema: match.schema, value: match.inlineValue, tokens: [token], ambiguous: match.inlineValue !== undefined });
      index += 1;
      continue;
    }
    if (match.inlineValue !== undefined) {
      parsed.push({ schema: match.schema, value: match.inlineValue, tokens: [token], ambiguous: false });
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value === "--") {
      if (strict) throw new Error(`Incomplete treatment argument: ${token}`);
      parsed.push({ schema: match.schema, tokens: [token], ambiguous: true });
      index += 1;
      continue;
    }
    parsed.push({ schema: match.schema, value, tokens: [token, value], ambiguous: false });
    index += 2;
  }
  return parsed;
}

function argumentIdentity(argument: ParsedTreatmentArgument): string | undefined {
  if (argument.schema.key !== "config") return argument.schema.key;
  const value = argument.value ?? "";
  const separator = value.indexOf("=");
  if (separator <= 0) return undefined;
  return `${argument.schema.key}:${value.slice(0, separator)}`;
}

/**
 * Merge explicit provider arguments with a validated treatment. Explicit
 * flags and their values always win. Only known treatment flags are parsed;
 * arbitrary prompt/positional values are left untouched, including values
 * that happen to resemble flags. An incomplete or ambiguous known argument
 * throws so the launcher can fail open to the original invocation.
 */
export function mergeTreatmentArguments(provider: Provider, explicitArgs: string[], injectedArgs: string[]): TreatmentMergeResult {
  if (injectedArgs.length === 0) return { args: [...explicitArgs], applied: false, deduplicated: false, conflicts: [], omitted: [] };
  const schemas = schemasFor(provider);
  let injected: ParsedTreatmentArgument[];
  let explicit: ParsedTreatmentArgument[];
  try {
    injected = parseTreatmentArguments(injectedArgs, schemas, true);
    explicit = parseTreatmentArguments(explicitArgs, schemas, false);
  } catch (error) {
    return { args: [...explicitArgs], applied: false, deduplicated: false, conflicts: [error instanceof Error ? error.message : "ambiguous treatment arguments"], omitted: injectedArgs, reason: "treatment argument validation failed" };
  }
  const explicitByIdentity = new Map<string, ParsedTreatmentArgument[]>();
  for (const argument of explicit) {
    if (argument.ambiguous) return { args: [...explicitArgs], applied: false, deduplicated: false, conflicts: [argument.tokens[0] ?? "ambiguous"], omitted: injectedArgs, reason: "ambiguous explicit treatment argument" };
    const identity = argumentIdentity(argument);
    if (!identity) return { args: [...explicitArgs], applied: false, deduplicated: false, conflicts: [argument.tokens[0] ?? "ambiguous"], omitted: injectedArgs, reason: "ambiguous Codex config argument" };
    explicitByIdentity.set(identity, [...(explicitByIdentity.get(identity) ?? []), argument]);
  }
  const selected: string[] = [];
  const injectedByIdentity = new Map<string, ParsedTreatmentArgument>();
  const omitted: string[] = [];
  const conflicts: string[] = [];
  for (const argument of injected) {
    const identity = argumentIdentity(argument);
    if (!identity) return { args: [...explicitArgs], applied: false, deduplicated: false, conflicts: [argument.tokens[0] ?? "invalid"], omitted: injectedArgs, reason: "invalid injected treatment argument" };
    const prior = injectedByIdentity.get(identity);
    if (prior) {
      if (prior.tokens.join("\0") !== argument.tokens.join("\0")) conflicts.push(identity);
      continue;
    }
    injectedByIdentity.set(identity, argument);
    const explicitMatches = explicitByIdentity.get(identity) ?? [];
    if (explicitMatches.length === 0) {
      selected.push(...argument.tokens);
      continue;
    }
    const explicitValues = new Set(explicitMatches.map((match) => match.value));
    if (argument.schema.takesValue && (explicitValues.size > 1 || [...explicitValues][0] !== argument.value)) conflicts.push(identity);
    else if (!argument.schema.takesValue && explicitMatches.some((match) => match.value !== undefined)) conflicts.push(identity);
    else omitted.push(identity);
  }
  if (conflicts.length > 0) return { args: [...explicitArgs], applied: false, deduplicated: false, conflicts: [...new Set(conflicts)], omitted: [...injectedByIdentity.keys()], reason: "explicit treatment value conflicts with the fixed policy" };
  return { args: [...selected, ...explicitArgs], applied: true, deduplicated: omitted.length > 0, conflicts: [], omitted };
}

const NONE: OptimizationPlan = { args: [], applied: false };
const CODEX_DEFERRED_WORLD_STATE_MODELS = new Set(["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-5.5"]);

function supports(help: string, option: string): boolean {
  return help.includes(option);
}

/**
 * Convert a confirmed CLI capability set into a bounded, session-scoped policy.
 * Kept pure so every provider policy has a direct unit test.
 */
export function planFromHelp(provider: Provider, mode: RunMode, help: string, codexModel?: string, nativeCodexVersion?: string): OptimizationPlan {
  if (!appliesReductionPolicy(mode)) return NONE;

  if (provider === "claude") {
    if (!supports(help, "--effort") || !supports(help, "--tools") || !supports(help, "--append-system-prompt")) {
      return { ...NONE, unavailableReason: "this Claude CLI does not expose the complete token-reduction policy" };
    }
    // v7 keeps v6's proven core-tool bound, removes optional Chrome startup,
    // preserves a more reusable system-prompt prefix, and uses a shorter
    // latency-first instruction. Older compatible CLIs retain the measured v6
    // policy rather than receiving flags they did not advertise.
    if (supports(help, "--no-chrome") && supports(help, "--exclude-dynamic-system-prompt-sections")) {
      return {
        args: [
          "--effort", "low",
          "--tools", CLAUDE_CORE_TOOLS,
          "--no-chrome",
          "--exclude-dynamic-system-prompt-sections",
          "--append-system-prompt", CLAUDE_TOKEN_EFFICIENCY_INSTRUCTION
        ],
        applied: true,
        profile: "claude-balanced-v7",
        summary: "low effort, core coding tools, no Chrome startup, stable cache prefix, one verification pass"
      };
    }
    return {
      args: [
        "--effort", "low",
        "--tools", CLAUDE_CORE_TOOLS,
        "--append-system-prompt", TOKEN_EFFICIENCY_INSTRUCTION
      ],
      applied: true,
      profile: "claude-balanced-v6",
      summary: "low effort, core coding tools, concise verified execution"
    };
  }

  if (provider === "codex") {
    if (!supports(help, "--config") && !supports(help, "-c,")) {
      return { ...NONE, unavailableReason: "this Codex CLI does not expose --config" };
    }
    if (!codexModel) {
      return { ...NONE, unavailableReason: "this Codex invocation has no unambiguous explicit model selector; measuring without treatment" };
    }
    const catalogueModels = new Set(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-daybreak-blue-latest", "gpt-5.5"]);
    if (catalogueModels.has(codexModel)) {
      const usesBatchedGuidance = codexModel === "gpt-6-astra" || codexModel === "gpt-6.1-sol";
      const usesDeferredWorldState = nativeCodexVersion === "0.160.1" && CODEX_DEFERRED_WORLD_STATE_MODELS.has(codexModel);
      const usesCodeMode = usesDeferredWorldState && codexModel === "gpt-5.5";
      const args = ["--config", "skills.max_context_tokens=2000", "--config", 'model_reasoning_effort="low"'];
      if (usesDeferredWorldState) args.push("--config", "features.deferred_tool_world_state=true");
      if (usesCodeMode) args.push("--config", "features.code_mode=true", "--config", "features.code_mode_only=true");
      if (codexModel === "gpt-5.5") args.push("--config", 'model_reasoning_summary="none"', "--config", 'model_verbosity="low"');
      else args.push("--config", "model_auto_compact_token_limit=16000", "--config", 'model_auto_compact_token_limit_scope="body_after_prefix"');
      const baseInstruction = usesBatchedGuidance || usesCodeMode ? CODEX_V20_TOKEN_EFFICIENCY_INSTRUCTION : codexModel === "gpt-6-luna" ? CODEX_V10_TOKEN_EFFICIENCY_INSTRUCTION : CODEX_V13_TOKEN_EFFICIENCY_INSTRUCTION;
      args.push("--config", `developer_instructions=${JSON.stringify(baseInstruction)}`);
      return { args, applied: true, profile: usesCodeMode ? "codex-balanced-v26" : usesDeferredWorldState ? "codex-balanced-v25" : usesBatchedGuidance ? "codex-balanced-v23" : "codex-balanced-v18", summary: "bounded native catalogues, low reasoning and complete required checks" };
    }
    return {
      args: ["--config", 'model_reasoning_effort="low"', "--config", 'model_reasoning_summary="none"', "--config", 'model_verbosity="low"', "--config", "model_auto_compact_token_limit=32000", "--config", 'model_auto_compact_token_limit_scope="body_after_prefix"', "--config", `developer_instructions=${JSON.stringify(CODEX_V3_TOKEN_EFFICIENCY_INSTRUCTION)}`],
      applied: true,
      profile: "codex-balanced-v3",
      summary: "other explicit model: low reasoning, low verbosity, 32k compaction, bounded batched execution"
    };
  }

  if (provider === "grok") {
    const effortOption = supports(help, "--reasoning-effort") ? "--reasoning-effort" : supports(help, "--effort") ? "--effort" : undefined;
    return effortOption && supports(help, "--verbatim") && supports(help, "--rules")
      ? {
          args: [
            effortOption, "low",
            "--verbatim",
            "--rules", GROK_TOKEN_EFFICIENCY_INSTRUCTION
          ],
          applied: true,
          profile: "grok-balanced-v8",
          summary: "low reasoning, bounded inspection and grouped checks; native capabilities preserved"
        }
      : { ...NONE, unavailableReason: "this Grok CLI does not expose the complete capability-preserving token-reduction policy" };
  }

  // Kimi remains fail-open until it offers a content-free, child-authenticated
  // session measurement interface. Advertised flags alone are insufficient.
  return { ...NONE, unavailableReason: "Kimi has no enabled safe measurement channel" };
}

/**
 * Probe only the installed provider binary. If the probe fails, do not mutate
 * the invocation: the wrapper remains fail-open and telemetry still works.
 */
export function planForInstalledCli(
  provider: Provider,
  mode: RunMode,
  binary: string,
  environment: NodeJS.ProcessEnv = process.env,
  verifyBinary: (candidate: string) => boolean = () => true,
  codexModel?: string
): OptimizationPlan {
  if (!appliesReductionPolicy(mode)) return NONE;
  try {
    if (!verifyBinary(binary)) return { ...NONE, unavailableReason: "could not verify this CLI executable before applying a policy" };
    const result = spawnSync(binary, ["--help"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: environment
    });
    if (result.error || result.status !== 0) {
      return { ...NONE, unavailableReason: "could not verify this CLI version before applying a policy" };
    }
    let nativeCodexVersion: string | undefined;
    if (provider === "codex" && codexModel && CODEX_DEFERRED_WORLD_STATE_MODELS.has(codexModel)) {
      const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "ignore"], env: environment });
      if (!version.error && version.status === 0) nativeCodexVersion = version.stdout.trim().match(/^codex(?:-cli)? (\d+\.\d+\.\d+)$/)?.[1];
    }
    const plan = planFromHelp(provider, mode, result.stdout, codexModel, nativeCodexVersion);
    if (!plan.applied) return plan;
    // Help advertises top-level flags, but Codex configuration keys and some
    // provider option combinations can still be rejected by the exact local
    // version. Probe the complete fixed plan without starting an AI session.
    const validation = spawnSync(binary, [...plan.args, ...(plan.headlessArgs ?? []), "--help"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "ignore", "ignore"],
      env: environment
    });
    if (validation.error || validation.status !== 0) {
      return { ...NONE, unavailableReason: "this CLI rejected the complete token-reduction policy" };
    }
    return plan;
  } catch {
    return { ...NONE, unavailableReason: "could not verify this CLI version before applying a policy" };
  }
}
