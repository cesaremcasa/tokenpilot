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
 * Grok v6 replaces the large native instruction prefix with a concise coding
 * contract and makes inspection/edit/verification phases explicitly bounded.
 * Headless sessions additionally expose only the terminal tool, which remains
 * capable of search, reads, edits, and verification while avoiding repeated
 * tool-schema context. Deep/off/bypass retain the complete native environment.
 */
export const GROK_TOKEN_EFFICIENCY_INSTRUCTION = "Complete the request with minimal total context. For repository inspection, make exactly one batched terminal call combining every needed search and read, then answer without another tool call. Preserve privacy and unrelated work. If editing is requested, make one batched inspection call, one edit call, one verification call, then stop. Answer concisely.";
export const GROK_HEADLESS_TOOLS = "run_terminal_cmd";

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

interface TreatmentArgumentSchema {
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
  { key: "effort", flags: ["--effort", "--reasoning-effort"], takesValue: true },
  { key: "tools", flags: ["--tools"], takesValue: true },
  { key: "config", flags: ["--config", "-c"], takesValue: true },
  { key: "append-system-prompt", flags: ["--append-system-prompt"], takesValue: true },
  { key: "system-prompt-override", flags: ["--system-prompt-override"], takesValue: true },
  { key: "no-chrome", flags: ["--no-chrome"], takesValue: false },
  { key: "exclude-dynamic-system-prompt-sections", flags: ["--exclude-dynamic-system-prompt-sections"], takesValue: false },
  { key: "verbatim", flags: ["--verbatim"], takesValue: false },
  { key: "no-subagents", flags: ["--no-subagents"], takesValue: false },
  { key: "no-memory", flags: ["--no-memory"], takesValue: false },
  { key: "disable-web-search", flags: ["--disable-web-search"], takesValue: false },
  { key: "no-plan", flags: ["--no-plan"], takesValue: false }
];

function argumentMatch(token: string): { schema: TreatmentArgumentSchema; inlineValue?: string } | undefined {
  for (const schema of TREATMENT_ARGUMENT_SCHEMAS) {
    for (const flag of schema.flags) {
      if (token === flag) return { schema };
      if (token.startsWith(`${flag}=`)) return { schema, inlineValue: token.slice(flag.length + 1) };
    }
  }
  return undefined;
}

function parseTreatmentArguments(args: string[], strict: boolean): ParsedTreatmentArgument[] {
  const parsed: ParsedTreatmentArgument[] = [];
  for (let index = 0; index < args.length;) {
    const token = args[index];
    if (token === "--") break;
    const match = argumentMatch(token);
    if (!match) {
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

function argumentIdentity(argument: ParsedTreatmentArgument): string {
  if (argument.schema.key !== "config") return argument.schema.key;
  const value = argument.value ?? "";
  const separator = value.indexOf("=");
  if (separator <= 0) {
    if (argument.ambiguous) throw new Error("Ambiguous Codex config argument");
    throw new Error("Codex config argument must include a key and value");
  }
  return `${argument.schema.key}:${value.slice(0, separator)}`;
}

/**
 * Merge explicit provider arguments with a validated treatment. Explicit
 * flags and their values always win. Only known treatment flags are parsed;
 * arbitrary prompt/positional values are left untouched, including values
 * that happen to resemble flags. An incomplete or ambiguous known argument
 * throws so the launcher can fail open to the original invocation.
 */
export function mergeTreatmentArguments(explicitArgs: string[], injectedArgs: string[]): string[] {
  if (injectedArgs.length === 0) return [...explicitArgs];
  const injected = parseTreatmentArguments(injectedArgs, true);
  const explicit = parseTreatmentArguments(explicitArgs, false);
  const explicitByIdentity = new Map<string, ParsedTreatmentArgument[]>();
  for (const argument of explicit) {
    if (argument.ambiguous) throw new Error("Ambiguous explicit treatment argument");
    const identity = argumentIdentity(argument);
    explicitByIdentity.set(identity, [...(explicitByIdentity.get(identity) ?? []), argument]);
  }
  const selected: string[] = [];
  const injectedByIdentity = new Map<string, ParsedTreatmentArgument>();
  for (const argument of injected) {
    const identity = argumentIdentity(argument);
    const prior = injectedByIdentity.get(identity);
    if (prior) {
      if (prior.tokens.join("\0") !== argument.tokens.join("\0")) throw new Error(`Conflicting injected treatment argument: ${identity}`);
      continue;
    }
    injectedByIdentity.set(identity, argument);
    // Any explicit occurrence owns this component, whether it matches or
    // intentionally overrides the treatment value. Preserve it in place.
    if (!explicitByIdentity.has(identity)) selected.push(...argument.tokens);
  }
  return [...selected, ...explicitArgs];
}

const NONE: OptimizationPlan = { args: [], applied: false };

function supports(help: string, option: string): boolean {
  return help.includes(option);
}

/**
 * Convert a confirmed CLI capability set into a bounded, session-scoped policy.
 * Kept pure so every provider policy has a direct unit test.
 */
export function planFromHelp(provider: Provider, mode: RunMode, help: string): OptimizationPlan {
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
    return {
      args: [
        "--config", "model_reasoning_effort=\"low\"",
        "--config", "model_reasoning_summary=\"none\"",
        "--config", "model_verbosity=\"low\"",
        "--config", "model_auto_compact_token_limit=32000",
        "--config", "model_auto_compact_token_limit_scope=\"body_after_prefix\"",
        "--config", `developer_instructions=${JSON.stringify(TOKEN_EFFICIENCY_INSTRUCTION)}`
      ],
      applied: true,
      profile: "codex-balanced-v2",
      summary: "low reasoning, no reasoning summary, low verbosity, compact body at 32k tokens"
    };
  }

  if (provider === "grok") {
    const effortOption = supports(help, "--reasoning-effort") ? "--reasoning-effort" : supports(help, "--effort") ? "--effort" : undefined;
    return effortOption && supports(help, "--verbatim") && supports(help, "--no-subagents") && supports(help, "--no-memory")
      && supports(help, "--disable-web-search") && supports(help, "--no-plan") && supports(help, "--system-prompt-override") && supports(help, "--tools")
      ? {
          args: [
            effortOption, "low",
            "--verbatim",
            "--no-subagents",
            "--no-memory",
            "--disable-web-search",
            "--no-plan",
            "--system-prompt-override", GROK_TOKEN_EFFICIENCY_INSTRUCTION
          ],
          headlessArgs: ["--tools", GROK_HEADLESS_TOOLS],
          applied: true,
          profile: "grok-balanced-v6",
          summary: "minimal system prefix, one batched terminal workflow, low reasoning, no subagents, memory, web, or plan mode"
        }
      : { ...NONE, unavailableReason: "this Grok CLI does not expose the complete token-reduction policy" };
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
  verifyBinary: (candidate: string) => boolean = () => true
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
    const plan = planFromHelp(provider, mode, result.stdout);
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
