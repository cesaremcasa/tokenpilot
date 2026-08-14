import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { install, launchAgentServiceTarget, uninstall } from "../src/installer.js";
import { findOriginalBinary, isPassthrough } from "../src/launcher.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("installation and fail-open launcher lookup", () => {
  it("uses launchctl's single service-target form when replacing the local agent", () => {
    expect(launchAgentServiceTarget("gui/501")).toBe("gui/501/com.tokenpilot.agent");
  });

  it("creates removable per-provider shims without changing the shell when requested", () => {
    const paths = temporaryPaths();
    const plan = install(paths, { noShellConfig: true, noAgent: true, executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    expect(plan.shims).toHaveLength(4);
    expect(plan.command).toBe(path.join(paths.shimDir, "tokenpilot"));
    expect(plan.skills).toHaveLength(3);
    expect(fs.readFileSync(plan.skills[0], "utf8")).toContain("tokenpilot-managed-skill");
    expect(fs.readFileSync(plan.skills[1], "utf8")).toContain("tokenpilot-managed-skill");
    expect(fs.readFileSync(plan.skills[2], "utf8")).toContain("tokenpilot-managed-skill");
    expect(fs.readFileSync(plan.skills[0], "utf8")).toContain(`'${plan.command}' report --format md`);
    expect(fs.readFileSync(plan.skills[0], "utf8")).not.toContain("{{TOKENPILOT_COMMAND}}");
    const shim = fs.readFileSync(path.join(paths.shimDir, "codex"), "utf8");
    expect(shim).toContain("__shim codex");
    expect(shim).toContain("# tokenpilot-shim");
    const command = fs.readFileSync(plan.command, "utf8");
    expect(command).toContain("# tokenpilot-command-shim");
    expect(command).toContain('"$@"');
    uninstall(paths);
    expect(fs.existsSync(path.join(paths.shimDir, "codex"))).toBe(false);
    expect(fs.existsSync(plan.command)).toBe(false);
    expect(fs.existsSync(plan.skills[0])).toBe(false);
    expect(fs.existsSync(plan.skills[1])).toBe(false);
    expect(fs.existsSync(plan.skills[2])).toBe(false);
    cleanup(paths);
  });

  it("uses the active shell's startup file when shell setup is enabled", () => {
    const paths = temporaryPaths();
    const plan = install(paths, {
      noAgent: true,
      shell: "/bin/zsh",
      executable: "/opt/tokenpilot/dist/cli.js",
      nodeExecutable: "/usr/local/bin/node"
    });
    const shellFile = path.join(paths.userHome, ".zshrc");
    expect(plan.shellFile).toBe(shellFile);
    expect(fs.readFileSync(shellFile, "utf8")).toContain(paths.shimDir);
    uninstall(paths);
    expect(fs.readFileSync(shellFile, "utf8")).not.toContain("tokenpilot");
    cleanup(paths);
  });

  it("installs a working tokenpilot command for the report skill", () => {
    const paths = temporaryPaths();
    const fakeCli = path.join(paths.userHome, "fake-cli.sh");
    fs.writeFileSync(fakeCli, "#!/bin/sh\nprintf '%s' \"$*\"\n", { mode: 0o700 });
    const plan = install(paths, {
      noShellConfig: true,
      noAgent: true,
      executable: fakeCli,
      nodeExecutable: "/bin/sh"
    });

    const result = spawnSync(plan.command, ["report", "--format", "md"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("report --format md");
    uninstall(paths);
    cleanup(paths);
  });

  it("runs from a private runtime bundle after the development checkout is gone", () => {
    const paths = temporaryPaths();
    const source = path.join(paths.userHome, "checkout");
    const sourceCli = path.join(source, "dist", "cli.js");
    const sourceSkill = path.join(source, ".agents", "skills", "tokenpilot", "SKILL.md");
    fs.mkdirSync(path.dirname(sourceCli), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(sourceSkill), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourceCli, "process.stdout.write(`runtime ${process.argv.slice(2).join(' ')}`);\n", { mode: 0o600 });
    fs.writeFileSync(sourceSkill, "tokenpilot-managed-skill\n{{TOKENPILOT_COMMAND}}\n", { mode: 0o600 });

    const plan = install(paths, {
      noShellConfig: true,
      noAgent: true,
      executable: sourceCli,
      nodeExecutable: process.execPath
    });
    const command = fs.readFileSync(plan.command, "utf8");
    expect(command).not.toContain(source);
    expect(command).toContain(path.join(paths.runtimeDir, "releases"));

    fs.rmSync(source, { recursive: true, force: true });
    const result = spawnSync(plan.command, ["report", "--format", "md"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("runtime report --format md");
    uninstall(paths);
    cleanup(paths);
  });

  it("skips its own shim directory when locating the original provider binary", () => {
    const paths = temporaryPaths();
    const originalBin = path.join(paths.userHome, "original-bin");
    fs.mkdirSync(originalBin, { recursive: true });
    const original = path.join(originalBin, "codex");
    fs.writeFileSync(original, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.mkdirSync(paths.shimDir, { recursive: true });
    fs.writeFileSync(path.join(paths.shimDir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(fs.realpathSync(findOriginalBinary("codex", paths, `${paths.shimDir}${path.delimiter}${originalBin}`)!)).toBe(fs.realpathSync(original));
    expect(isPassthrough(["login"])).toBe(true);
    expect(isPassthrough(["--version"])).toBe(true);
    expect(isPassthrough(["update"])).toBe(true);
    expect(isPassthrough(["mcp"])).toBe(true);
    expect(isPassthrough([])).toBe(false);
    cleanup(paths);
  });

  it("refuses to overwrite a non-TokenPilot shim", () => {
    const paths = temporaryPaths();
    fs.mkdirSync(paths.shimDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.shimDir, "codex"), "#!/bin/sh\necho foreign\n", { mode: 0o700 });

    expect(() => install(paths, { noShellConfig: true, noAgent: true })).toThrow("Refusing to overwrite non-TokenPilot shim");
    expect(fs.readFileSync(path.join(paths.shimDir, "codex"), "utf8")).toContain("foreign");
    cleanup(paths);
  });

  it("refuses a foreign TokenPilot command before creating a partial installation", () => {
    const paths = temporaryPaths();
    fs.mkdirSync(paths.shimDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.shimDir, "tokenpilot"), "#!/bin/sh\necho foreign\n", { mode: 0o700 });

    expect(() => install(paths, { noShellConfig: true, noAgent: true })).toThrow("Refusing to overwrite non-TokenPilot command shim");
    expect(fs.readFileSync(path.join(paths.shimDir, "tokenpilot"), "utf8")).toContain("foreign");
    expect(fs.existsSync(path.join(paths.shimDir, "codex"))).toBe(false);
    expect(fs.existsSync(paths.configFile)).toBe(false);
    cleanup(paths);
  });

  it("refuses to overwrite a non-TokenPilot personal skill", () => {
    const paths = temporaryPaths();
    const skill = path.join(paths.userHome, ".agents", "skills", "tokenpilot", "SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true, mode: 0o700 });
    fs.writeFileSync(skill, "---\nname: tokenpilot\n---\nforeign\n", { mode: 0o600 });

    expect(() => install(paths, { noShellConfig: true, noAgent: true })).toThrow("Refusing to overwrite non-TokenPilot skill");
    expect(fs.readFileSync(skill, "utf8")).toContain("foreign");
    cleanup(paths);
  });

  it("refuses to overwrite a LaunchAgent that merely reuses its label", () => {
    const paths = temporaryPaths();
    fs.mkdirSync(path.dirname(paths.launchAgentFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.launchAgentFile, "<plist><string>com.tokenpilot.agent</string></plist>", { mode: 0o600 });

    expect(() => install(paths, { noShellConfig: true })).toThrow("Refusing to overwrite non-TokenPilot LaunchAgent");
    cleanup(paths);
  });

  it("refuses a TokenPilot state path with a symlinked ancestor", () => {
    const paths = temporaryPaths();
    const foreign = path.join(paths.userHome, "foreign");
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.symlinkSync(foreign, paths.home);

    expect(() => install(paths, { noShellConfig: true, noAgent: true })).toThrow("Refusing unsafe TokenPilot directory");
    cleanup(paths);
  });

  it("rejects original binaries from a world-writable directory", () => {
    const paths = temporaryPaths();
    const unsafeBin = path.join(paths.userHome, "unsafe-bin");
    fs.mkdirSync(unsafeBin, { recursive: true, mode: 0o777 });
    fs.chmodSync(unsafeBin, 0o777);
    fs.writeFileSync(path.join(unsafeBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(findOriginalBinary("codex", paths, unsafeBin)).toBeUndefined();
    cleanup(paths);
  });

  it("rejects a provider executable that is group-writable", () => {
    const paths = temporaryPaths();
    const providerBin = path.join(paths.userHome, "provider-bin");
    fs.mkdirSync(providerBin, { recursive: true, mode: 0o700 });
    const provider = path.join(providerBin, "codex");
    fs.writeFileSync(provider, "#!/bin/sh\nexit 0\n", { mode: 0o720 });
    fs.chmodSync(provider, 0o720);

    expect(findOriginalBinary("codex", paths, providerBin)).toBeUndefined();
    cleanup(paths);
  });
});
