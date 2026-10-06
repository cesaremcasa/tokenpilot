import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { readCodexSkillBudget } from "../src/codex-skill-catalog.js";

function mockServer(responses: Record<string, object>) {
  const stdout = new PassThrough();
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: vi.fn((line: string) => {
      const request = JSON.parse(line);
      const response = responses[request.method];
      if (response) queueMicrotask(() => stdout.write(`${JSON.stringify({ id: request.id, ...response })}\n`));
      return true;
    }),
    end: vi.fn()
  });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stdin,
    kill: vi.fn(() => true)
  });
  spawnMock.mockReturnValue(child);
  return { child, stdin };
}

describe("readCodexSkillBudget", () => {
  beforeEach(() => spawnMock.mockReset());

  it("requests only skill metadata and computes the bounded budget", async () => {
    const { child, stdin } = mockServer({
      initialize: { result: { protocolVersion: "2025-03-26" } },
      "skills/list": { result: { data: [{ errors: [], skills: [
        { name: "enabled", path: "/skills/a", enabled: true },
        { name: "disabled", path: "/skills/b", enabled: false }
      ] }] } }
    });
    const budget = await readCodexSkillBudget("codex", "/repo", process.env);
    const expected = Math.max(2_000,
      Math.ceil(Buffer.byteLength("- enabled: (file: /skills/a)\n") / 4)
      + Math.ceil(Buffer.byteLength("- disabled: (file: /skills/b)\n") / 4)
      + 512);
    expect(budget).toBe(expected);
    expect(spawnMock).toHaveBeenCalledWith("codex", ["app-server"], expect.objectContaining({ cwd: "/repo", stdio: ["pipe", "pipe", "ignore"] }));
    expect(stdin.write).toHaveBeenCalledWith(expect.stringContaining('"method":"skills/list","params":{"cwds":["/repo"],"forceReload":false}'));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(stdin.end).toHaveBeenCalled();
  });

  it("fails open on API errors and malformed responses", async () => {
    mockServer({ initialize: { error: { code: -1 } } });
    await expect(readCodexSkillBudget("codex", "/repo", process.env)).resolves.toBeUndefined();

    mockServer({
      initialize: { result: {} },
      "skills/list": { result: { data: [{ errors: [], skills: [{ name: "missing-path", enabled: true }] }] } }
    });
    await expect(readCodexSkillBudget("codex", "/repo", process.env)).resolves.toBeUndefined();
  });

  it("rejects an empty catalog and a budget above the native limit", async () => {
    mockServer({ initialize: { result: {} }, "skills/list": { result: { data: [] } } });
    await expect(readCodexSkillBudget("codex", "/repo", process.env)).resolves.toBeUndefined();

    mockServer({
      initialize: { result: {} },
      "skills/list": { result: { data: [{ errors: [], skills: [
        { name: "x".repeat(40_000), path: "/skills/x", enabled: true }
      ] }] } }
    });
    await expect(readCodexSkillBudget("codex", "/repo", process.env)).resolves.toBeUndefined();
  });

  it("fails open when the subprocess input stream errors", async () => {
    const { stdin } = mockServer({});
    queueMicrotask(() => stdin.emit("error", new Error("EPIPE")));
    await expect(readCodexSkillBudget("codex", "/repo", process.env)).resolves.toBeUndefined();
  });
});
