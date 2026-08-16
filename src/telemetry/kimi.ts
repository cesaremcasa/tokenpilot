import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import net from "node:net";

export interface KimiHeadlessRequest {
  prompt: string;
  model?: string;
}

export interface KimiMeasuredUsage {
  inputNew: number;
  inputCached: number;
  cacheCreated: number;
  output: number;
  modelCalls: number;
  retries: number;
  compactions: number;
}

export interface KimiBridgeResult {
  exitCode: number;
  promptAccepted: boolean;
  usage?: KimiMeasuredUsage;
}

interface KimiEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface KimiUsageShape {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}

interface KimiWireFrame {
  type?: string;
  session_id?: string;
  id?: string;
  code?: number;
  payload?: Record<string, unknown>;
}

const KIMI_WEB_MIN_VERSION = [0, 36, 1] as const;

/**
 * Audited Kimi 0.36.x managed models without `support_efforts` expose the
 * documented boolean thinking control. `off` is therefore the only reduced
 * setting TokenPilot may claim for this protocol family; arbitrary labels
 * such as `low` can be accepted and silently normalized by the server.
 */
export const KIMI_BALANCED_THINKING = "off" as const;

/** Optional Kimi tools removed only from balanced text-print sessions. */
export const KIMI_BALANCED_DISABLED_TOOLS = [
  "Agent",
  "AskUserQuestion",
  "CreateGoal",
  "CronCreate",
  "CronDelete",
  "CronList",
  "FetchURL",
  "GetGoal",
  "ReadMediaFile",
  "SetGoalBudget",
  "Skill",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TodoList",
  "UpdateGoal",
  "WebSearch",
  "select_tools"
] as const;

/**
 * Parse only the small print-mode surface that the local Kimi bridge can
 * reproduce exactly enough to remain transparent. Unknown flags, resume,
 * goals, and stream-json all fall back to the original CLI unchanged.
 */
export function kimiHeadlessRequest(args: string[], environment: NodeJS.ProcessEnv = process.env): KimiHeadlessRequest | undefined {
  let prompt: string | undefined;
  let model: string | undefined;
  let outputFormat = environment.KIMI_MODEL_OUTPUT_FORMAT?.trim() || "text";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-p" || argument === "--prompt") {
      const value = args[index + 1];
      if (value === undefined) return undefined;
      prompt = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--prompt=")) {
      prompt = argument.slice("--prompt=".length);
      continue;
    }
    if (argument === "--model") {
      const value = args[index + 1];
      if (value === undefined) return undefined;
      model = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--model=")) {
      model = argument.slice("--model=".length);
      continue;
    }
    if (argument === "--output-format") {
      const value = args[index + 1];
      if (value === undefined) return undefined;
      outputFormat = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--output-format=")) {
      outputFormat = argument.slice("--output-format=".length);
      continue;
    }
    return undefined;
  }
  return prompt !== undefined && prompt.length > 0 && outputFormat === "text" ? { prompt, model } : undefined;
}

export function supportsKimiWebBridgeVersion(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  // The bridge is deliberately constrained to the protocol family audited in
  // Kimi 0.36.x. A later minor/major must be reviewed instead of guessed.
  if (actual[0] !== 0 || actual[1] !== 36) return false;
  return actual[2] >= KIMI_WEB_MIN_VERSION[2];
}

export function supportsKimiWebBridge(binary: string, version: string | undefined, environment: NodeJS.ProcessEnv): boolean {
  if (!supportsKimiWebBridgeVersion(version)) return false;
  try {
    const probe = spawnSync(binary, ["web", "--help"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: environment
    });
    return !probe.error && probe.status === 0
      && probe.stdout.includes("--port")
      && probe.stdout.includes("--no-open");
  } catch {
    return false;
  }
}

/** Content-free accumulator for the documented numeric Kimi event fields. */
export class KimiUsageAccumulator {
  private readonly usage: KimiMeasuredUsage = {
    inputNew: 0,
    inputCached: 0,
    cacheCreated: 0,
    output: 0,
    modelCalls: 0,
    retries: 0,
    compactions: 0
  };
  private sawStepUsage = false;
  private statusTotal?: KimiUsageShape;

  accept(frame: KimiWireFrame): void {
    const payload = frame.payload ?? {};
    if (frame.type === "turn.step.completed") {
      const numeric = usageShape(payload.usage);
      if (numeric) {
        this.sawStepUsage = true;
        this.usage.inputNew += numeric.inputOther ?? 0;
        this.usage.inputCached += numeric.inputCacheRead ?? 0;
        this.usage.cacheCreated += numeric.inputCacheCreation ?? 0;
        this.usage.output += numeric.output ?? 0;
        this.usage.modelCalls += 1;
      }
    }
    if (frame.type === "agent.status.updated") {
      const status = object(payload.usage);
      const total = usageShape(status?.total);
      if (total) this.statusTotal = total;
    }
    if (frame.type === "turn.step.retrying") this.usage.retries += 1;
    if (frame.type === "compaction.completed") this.usage.compactions += 1;
  }

  finish(): KimiMeasuredUsage | undefined {
    if (this.sawStepUsage) return { ...this.usage };
    if (!this.statusTotal) return undefined;
    return {
      ...this.usage,
      inputNew: this.statusTotal.inputOther ?? 0,
      inputCached: this.statusTotal.inputCacheRead ?? 0,
      cacheCreated: this.statusTotal.inputCacheCreation ?? 0,
      output: this.statusTotal.output ?? 0,
      modelCalls: 1
    };
  }
}

/**
 * Execute one stock Kimi print session through its documented local REST/WS
 * surface. Kimi still owns provider auth and the session; TokenPilot supplies
 * only an ephemeral loopback password and retains numeric counters alone.
 */
export async function runKimiHeadless(
  binary: string,
  request: KimiHeadlessRequest,
  environment: NodeJS.ProcessEnv,
  treatment: boolean
): Promise<KimiBridgeResult> {
  const port = await reserveLoopbackPort();
  const secret = randomUUID().replaceAll("-", "");
  const origin = `http://127.0.0.1:${port}/`;
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const server = spawn(binary, ["web", "--port", String(port), "--no-open", "--log-level", "silent"], {
    cwd: process.cwd(),
    env: { ...environment, KIMI_CODE_PASSWORD: secret, KIMI_DISABLE_TELEMETRY: "1" },
    stdio: "ignore"
  });
  let promptAccepted = false;
  let socket: WebSocket | undefined;
  try {
    await waitForServer(server, origin, headers.authorization);
    const config = await api<{ default_model?: string }>(origin, "config", headers);
    const model = request.model ?? config.default_model;
    if (!model) throw new Error("Kimi has no configured default model");
    const session = await api<{ id?: string }>(origin, "sessions", headers, {
      method: "POST",
      body: JSON.stringify({ metadata: { cwd: process.cwd() } })
    });
    if (!session.id || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id)) throw new Error("Kimi did not create a valid session");
    const result = await runTurn(origin, headers, secret, session.id, request.prompt, model, treatment, (value) => {
      promptAccepted = value;
    });
    socket = result.socket;
    return { exitCode: result.exitCode, promptAccepted, usage: result.usage };
  } catch (error) {
    if (!promptAccepted) throw error;
    process.stderr.write(`Kimi local session failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    return { exitCode: 1, promptAccepted: true };
  } finally {
    socket?.close();
    await stopServer(server);
  }
}

async function runTurn(
  origin: string,
  headers: Record<string, string>,
  secret: string,
  sessionId: string,
  prompt: string,
  model: string,
  treatment: boolean,
  noteAccepted: (accepted: boolean) => void
): Promise<{ exitCode: number; usage?: KimiMeasuredUsage; socket: WebSocket }> {
  const wsUrl = new URL("api/v1/ws", origin);
  wsUrl.protocol = "ws:";
  const socket = new WebSocket(wsUrl, [`kimi-code.bearer.${secret}`]);
  const accumulator = new KimiUsageAccumulator();
  let assistantWritten = false;
  let submitted = false;
  try {
    const result = await new Promise<{ exitCode: number; usage?: KimiMeasuredUsage }>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => settleReject(new Error("Kimi turn timed out")), 180_000);
      const settleResolve = (value: { exitCode: number; usage?: KimiMeasuredUsage }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const finish = (value: { exitCode: number; usage?: KimiMeasuredUsage }) => {
        if (settled) return;
        if (assistantWritten) process.stdout.write("\n");
        process.stderr.write(`To resume this session: kimi -r ${sessionId}\n`);
        settleResolve(value);
      };
      socket.addEventListener("error", () => settleReject(new Error("Kimi WebSocket failed")));
      socket.addEventListener("message", (message) => {
        void (async () => {
          if (settled) return;
          const frame = parseFrame(message.data);
          if (!frame) return;
          if (frame.type === "server_hello") {
            socket.send(JSON.stringify({
              type: "client_hello",
              id: "tokenpilot-hello",
              payload: { client_id: "tokenpilot", subscriptions: [sessionId] }
            }));
            return;
          }
          if (frame.type === "ack" && frame.id === "tokenpilot-hello" && frame.code === 0 && !submitted) {
            submitted = true;
            // From this point forward TokenPilot must never start a second
            // provider invocation: the POST may reach Kimi even if its local
            // response is interrupted. This preserves at-most-once execution.
            noteAccepted(true);
            await api(origin, `sessions/${encodeURIComponent(sessionId)}/prompts`, headers, {
              method: "POST",
              body: JSON.stringify({
                content: [{ type: "text", text: prompt }],
                profile: "agent",
                model,
                permission_mode: "auto",
                ...(treatment ? { thinking: KIMI_BALANCED_THINKING, disabled_tools: KIMI_BALANCED_DISABLED_TOOLS } : {})
              })
            });
            return;
          }
          if (frame.session_id !== sessionId) return;
          accumulator.accept(frame);
          const payload = frame.payload ?? {};
          if (frame.type === "assistant.delta" && typeof payload.delta === "string") {
            assistantWritten = true;
            process.stdout.write(payload.delta);
          } else if (frame.type === "thinking.delta" && typeof payload.delta === "string") {
            process.stderr.write(payload.delta);
          } else if (frame.type === "tool.progress") {
            const update = object(payload.update);
            if (typeof update?.text === "string") process.stderr.write(update.text.endsWith("\n") ? update.text : `${update.text}\n`);
          } else if (frame.type === "error") {
            settleReject(new Error(typeof payload.message === "string" ? payload.message : "Kimi provider error"));
          } else if (frame.type === "turn.ended") {
            const completed = payload.reason === "completed";
            finish({ exitCode: completed ? 0 : 1, usage: accumulator.finish() });
          }
        })().catch((error) => settleReject(error instanceof Error ? error : new Error("Kimi local session failed")));
      });
    });
    return { ...result, socket };
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function api<T = unknown>(
  origin: string,
  relative: string,
  headers: Record<string, string>,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(new URL(`api/v1/${relative}`, origin), {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(20_000)
  });
  const envelope = await response.json() as KimiEnvelope<T>;
  if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
    throw new Error(envelope.msg || `Kimi local API returned ${response.status}`);
  }
  return envelope.data;
}

async function waitForServer(server: ChildProcess, origin: string, authorization: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("Kimi local server exited before readiness");
    try {
      const response = await fetch(new URL("api/v1/meta", origin), { headers: { authorization } });
      if (response.ok) return;
    } catch {
      // Startup races are expected; the bounded retry loop remains local.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("Kimi local server did not become ready");
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : port ? resolve(port) : reject(new Error("Could not reserve a local port")));
    });
  });
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<void>((resolve) => server.once("exit", () => resolve())),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2_000))
  ]);
  if (exited === "timeout" && server.exitCode === null) {
    server.kill("SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => server.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    ]);
  }
}

function parseFrame(data: unknown): KimiWireFrame | undefined {
  try {
    const parsed = JSON.parse(typeof data === "string" ? data : String(data)) as unknown;
    return object(parsed) as KimiWireFrame | undefined;
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function usageShape(value: unknown): KimiUsageShape | undefined {
  const parsed = object(value);
  if (!parsed) return undefined;
  const keys = ["inputOther", "output", "inputCacheRead", "inputCacheCreation"] as const;
  const result: KimiUsageShape = {};
  let present = false;
  for (const key of keys) {
    const numeric = parsed[key];
    if (typeof numeric === "number" && Number.isFinite(numeric) && numeric >= 0) {
      result[key] = Math.trunc(numeric);
      present = true;
    }
  }
  return present ? result : undefined;
}
