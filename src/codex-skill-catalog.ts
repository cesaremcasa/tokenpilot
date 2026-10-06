import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

interface SkillMetadata {
  name: string;
  path: string;
  enabled: boolean;
}

/** Return a bounded context budget from enabled Codex skill metadata. */
export async function readCodexSkillBudget(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }

    let outputBytes = 0;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    let stage: "initialize" | "skills" = "initialize";
    let settled = false;
    let budget = 0;
    const finish = (value?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch { /* Best-effort process cleanup. */ }
      try {
        child.kill("SIGTERM");
      } catch { /* Best-effort process cleanup. */ }
      resolve(value);
    };
    const send = (message: object) => {
      if (!child.stdin || child.stdin.destroyed) throw new Error("app-server stdin is unavailable");
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(() => finish(), TIMEOUT_MS);

    child.on("error", () => finish());
    child.stdin?.on("error", () => finish());
    if (!child.stdout || !child.stdin) return finish();
    child.on("close", (code) => {
      if (code !== 0) finish();
      else if (!settled) finish();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return finish();
      buffer += decoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          return finish();
        }
        if (message?.error) return finish();
        if (stage === "initialize" && message?.id === 1 && message.result && typeof message.result === "object") {
          stage = "skills";
          try {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "skills/list", params: { cwds: [cwd], forceReload: false } });
          } catch {
            return finish();
          }
          continue;
        }
        if (stage !== "skills" || message?.id !== 2) continue;
        const entries = message?.result?.data;
        if (!Array.isArray(entries) || entries.length === 0) return finish();
        for (const entry of entries) {
          if (!Array.isArray(entry?.errors) || entry.errors.length !== 0 || !Array.isArray(entry.skills)) return finish();
          for (const skill of entry.skills as SkillMetadata[]) {
            if (typeof skill?.name !== "string" || typeof skill.path !== "string" || typeof skill.enabled !== "boolean") return finish();
            budget += Math.ceil(Buffer.byteLength(`- ${skill.name}: (file: ${skill.path})\n`) / 4);
          }
        }
        const total = Math.max(2_000, budget + 512);
        finish(total <= 10_000 ? total : undefined);
        return;
      }
    });

    try {
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "tokenpilot", version: "0.5.5" } } });
    } catch {
      finish();
    }
  });
}
