import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertRuntimeSupported, install, launchAgentServiceTarget, runtimeSupport, shouldInstallLaunchAgent, uninstall } from "../src/installer.js";
import { findOriginalBinary, isPassthrough, providerEnvironment } from "../src/launcher.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("installation and fail-open launcher lookup", () => {
  it("does not create a macOS LaunchAgent in a Linux installation plan", () => {
    expect(shouldInstallLaunchAgent("linux")).toBe(false);
    expect(shouldInstallLaunchAgent("darwin")).toBe(true);
    expect(shouldInstallLaunchAgent("darwin", true)).toBe(false);
  });

  it("uses launchctl's single service-target form when replacing the local agent", () => {
    expect(launchAgentServiceTarget("gui/501")).toBe("gui/501/com.tokenpilot.agent");
  });

  it("supports only macOS/Linux with Node 22.5 or newer before any install write", () => {
    expect(runtimeSupport("darwin", "22.5.0").supported).toBe(true);
    expect(runtimeSupport("linux", "23.0.0").supported).toBe(true);
    expect(runtimeSupport("win32", "23.0.0")).toMatchObject({ supported: false, reason: expect.stringContaining("macOS and Linux") });
    expect(runtimeSupport("linux", "22.4.9")).toMatchObject({ supported: false, reason: expect.stringContaining("22.5") });
    expect(() => assertRuntimeSupported("linux", "22.4.9")).toThrow("Node 22.4.9 is unsupported");
  });

  it("creates removable per-provider shims without changing the shell when requested", () => {
    const paths = temporaryPaths();
    const plan = install(paths, { noShellConfig: true, noAgent: true, executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    expect(plan.shims).toHaveLength(4);
    expect(plan.command).toBe(path.join(paths.shimDir, "tokenpilot"));
    expect(plan.skills).toHaveLength(4);
    expect(plan.skills.map((skill) => skill.provider)).toEqual(["codex", "claude", "grok", "kimi"]);
    for (const skill of plan.skills) {
      const contents = fs.readFileSync(skill.target, "utf8");
      expect(contents).toContain(`tokenpilot-managed-skill:v6 ${skill.provider}`);
      expect(contents).toContain(`'${plan.command}' report --provider ${skill.provider} --view summary --format md`);
      expect(contents).toContain("The primary and required result is the live cache-aware variation and its evidence state");
      expect(contents).toContain("Never replace it with 24-hour or 7-day emptiness");
      expect(contents).not.toContain("{{TOKENPILOT_COMMAND}}");
      expect(skill.state).toBe("installed");
    }
    const shim = fs.readFileSync(path.join(paths.shimDir, "codex"), "utf8");
    expect(shim).toContain("__shim codex");
    expect(shim).toContain("# tokenpilot-shim");
    expect(shim).toContain("NODE_NO_WARNINGS=1");
    const command = fs.readFileSync(plan.command, "utf8");
    expect(command).toContain("# tokenpilot-command-shim");
    expect(command).toContain('"$@"');
    expect(command).toContain("NODE_NO_WARNINGS=1");
    uninstall(paths);
    expect(fs.existsSync(path.join(paths.shimDir, "codex"))).toBe(false);
    expect(fs.existsSync(plan.command)).toBe(false);
    for (const skill of plan.skills) expect(fs.existsSync(skill.target)).toBe(false);
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

  it("moves its exact PATH block to the end on reinstall so later local bins cannot shadow shims", () => {
    const paths = temporaryPaths();
    const shellFile = path.join(paths.userHome, ".zshrc");
    fs.writeFileSync(shellFile, `export PATH='${path.join(paths.userHome, ".local", "bin")}:$PATH\n`, { mode: 0o600 });
    install(paths, { noAgent: true, shell: "/bin/zsh", executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    // Simulate a package manager appending its own bin path after the first install.
    fs.appendFileSync(shellFile, `export PATH='${path.join(paths.userHome, ".local", "bin")}:$PATH\n`, { mode: 0o600 });
    install(paths, { noAgent: true, shell: "/bin/zsh", executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    const contents = fs.readFileSync(shellFile, "utf8");
    expect((contents.match(/# >>> tokenpilot >>>/g) ?? [])).toHaveLength(1);
    expect(contents.lastIndexOf("# >>> tokenpilot >>>")).toBeGreaterThan(contents.lastIndexOf(".local/bin"));
    cleanup(paths);
  });

  it("keeps Bash login shells behind their final profile PATH assignment", () => {
    const paths = temporaryPaths();
    const profile = path.join(paths.userHome, ".profile");
    fs.writeFileSync(profile, [
      'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
      `export PATH='${path.join(paths.userHome, ".local", "bin")}':"$PATH"`,
      ""
    ].join("\n"), { mode: 0o600 });

    const plan = install(paths, { noAgent: true, shell: "/bin/bash", executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    const bashrc = path.join(paths.userHome, ".bashrc");
    const profileContents = fs.readFileSync(profile, "utf8");
    expect(plan.shellFiles).toEqual([bashrc, profile]);
    expect(fs.readFileSync(bashrc, "utf8")).toContain(paths.shimDir);
    expect(profileContents.lastIndexOf("# >>> tokenpilot >>>")).toBeGreaterThan(profileContents.lastIndexOf(".local/bin"));

    uninstall(paths);
    expect(fs.readFileSync(profile, "utf8")).not.toContain("# >>> tokenpilot >>>");
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
    const sourceSkill = path.join(source, "integrations", "codex", "tokenpilot", "SKILL.md");
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

  it("upgrades a staged runtime without changing existing telemetry state", () => {
    const paths = temporaryPaths();
    const runtime = (version: string) => {
      const source = path.join(paths.userHome, `checkout-${version}`);
      const sourceCli = path.join(source, "dist", "cli.js");
      const sourceSkill = path.join(source, "integrations", "codex", "tokenpilot", "SKILL.md");
      fs.mkdirSync(path.dirname(sourceCli), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(sourceSkill), { recursive: true, mode: 0o700 });
      fs.writeFileSync(sourceCli, `process.stdout.write("tokenpilot ${version}\\n");\n`, { mode: 0o600 });
      fs.writeFileSync(sourceSkill, "tokenpilot-managed-skill\n{{TOKENPILOT_COMMAND}}\n", { mode: 0o600 });
      return sourceCli;
    };

    const first = install(paths, {
      noShellConfig: true,
      noAgent: true,
      noSkills: true,
      executable: runtime("0.4.17"),
      nodeExecutable: process.execPath
    });
    expect(spawnSync(first.command, [], { encoding: "utf8" }).stdout).toBe("tokenpilot 0.4.17\n");

    fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
    const telemetry = path.join(paths.dataDir, "telemetry.sqlite");
    fs.writeFileSync(telemetry, "preserve-me", { mode: 0o600 });

    const second = install(paths, {
      noShellConfig: true,
      noAgent: true,
      noSkills: true,
      executable: runtime("0.5.0"),
      nodeExecutable: process.execPath
    });
    expect(spawnSync(second.command, [], { encoding: "utf8" }).stdout).toBe("tokenpilot 0.5.0\n");
    expect(fs.readFileSync(telemetry, "utf8")).toBe("preserve-me");

    uninstall(paths);
    expect(fs.existsSync(telemetry)).toBe(true);
    cleanup(paths);
  });

  it("skips its own shim directory when locating the original provider binary", () => {
    const paths = temporaryPaths();
    const originalBin = path.join(paths.userHome, "original-bin");
    fs.mkdirSync(originalBin, { recursive: true, mode: 0o700 });
    const original = path.join(originalBin, "codex");
    fs.writeFileSync(original, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.mkdirSync(paths.shimDir, { recursive: true });
    fs.writeFileSync(path.join(paths.shimDir, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(fs.realpathSync(findOriginalBinary("codex", paths, `${paths.shimDir}${path.delimiter}${originalBin}`)!)).toBe(fs.realpathSync(original));
    expect(isPassthrough(["login"])).toBe(true);
    expect(isPassthrough(["--version"])).toBe(true);
    expect(isPassthrough(["update"])).toBe(true);
    expect(isPassthrough(["mcp"])).toBe(true);
    expect(isPassthrough(["--config", "model_reasoning_effort=\"low\"", "--help"])).toBe(true);
    expect(isPassthrough(["exec", "--", "--help"])).toBe(false);
    expect(isPassthrough([])).toBe(false);
    cleanup(paths);
  });

  it("finds an npm-installed provider beside TokenPilot's trusted Node runtime", () => {
    const paths = temporaryPaths();
    const runtimeBin = path.join(paths.userHome, "node-runtime", "bin");
    const runtimeNode = path.join(runtimeBin, "node");
    const provider = path.join(runtimeBin, "claude");
    fs.mkdirSync(runtimeBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(runtimeNode, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(provider, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.mkdirSync(paths.shimDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.shimDir, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(fs.realpathSync(findOriginalBinary("claude", paths, paths.shimDir, runtimeNode)!)).toBe(fs.realpathSync(provider));
    expect(providerEnvironment({}, provider, runtimeNode).PATH?.split(path.delimiter)).toContain(fs.realpathSync(runtimeBin));
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

  it("keeps wrappers working and skips a non-TokenPilot personal skill", () => {
    const paths = temporaryPaths();
    const skill = path.join(paths.userHome, ".agents", "skills", "tokenpilot", "SKILL.md");
    fs.mkdirSync(path.dirname(skill), { recursive: true, mode: 0o700 });
    fs.writeFileSync(skill, "---\nname: tokenpilot\n---\nforeign\n", { mode: 0o600 });

    const plan = install(paths, { noShellConfig: true, noAgent: true });
    expect(fs.readFileSync(skill, "utf8")).toContain("foreign");
    expect(plan.skills.find((candidate) => candidate.target === skill)).toMatchObject({ state: "skipped", reason: "a third-party skill already owns this target" });
    expect(fs.existsSync(path.join(paths.shimDir, "codex"))).toBe(true);
    cleanup(paths);
  });

  it("keeps wrappers working when an optional skill directory is unsafe or symlinked", () => {
    const paths = temporaryPaths();
    const unsafe = path.join(paths.userHome, ".agents");
    fs.mkdirSync(unsafe, { mode: 0o777 });
    fs.chmodSync(unsafe, 0o777);
    const privateTarget = path.join(paths.userHome, "private-claude");
    fs.mkdirSync(privateTarget, { mode: 0o700 });
    fs.symlinkSync(privateTarget, path.join(paths.userHome, ".claude"));

    const plan = install(paths, { noShellConfig: true, noAgent: true });
    expect(plan.skills.find((skill) => skill.target.includes(`${path.sep}.agents${path.sep}`))).toMatchObject({ state: "skipped" });
    expect(plan.skills.find((skill) => skill.target.includes(`${path.sep}.claude${path.sep}`))).toMatchObject({ state: "skipped" });
    expect(plan.skills.find((skill) => skill.provider === "grok")).toMatchObject({ state: "installed" });
    expect(fs.existsSync(path.join(paths.shimDir, "claude"))).toBe(true);
    expect(fs.existsSync(plan.command)).toBe(true);
    expect(fs.existsSync(path.join(privateTarget, "skills", "tokenpilot", "SKILL.md"))).toBe(false);
    uninstall(paths);
    cleanup(paths);
  });

  it("refuses to overwrite a LaunchAgent that merely reuses its label", () => {
    if (process.platform !== "darwin") return;
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

  it("refuses managed state with a macOS ACL", () => {
    if (process.platform !== "darwin") return;
    const paths = temporaryPaths();
    const acl = spawnSync("/bin/chmod", ["+a", "everyone allow write", paths.userHome], { encoding: "utf8" });
    expect(acl.status).toBe(0);

    expect(() => install(paths, { noShellConfig: true, noAgent: true })).toThrow("Refusing unsafe TokenPilot directory");
    cleanup(paths);
  });

  it("accepts the standard macOS home deny-delete ACL", () => {
    if (process.platform !== "darwin") return;
    const paths = temporaryPaths();
    const acl = spawnSync("/bin/chmod", ["+a", "everyone deny delete", paths.userHome], { encoding: "utf8" });
    expect(acl.status).toBe(0);

    expect(() => install(paths, { noShellConfig: true, noAgent: true, noSkills: true })).not.toThrow();
    uninstall(paths);
    spawnSync("/bin/chmod", ["-N", paths.userHome], { encoding: "utf8" });
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

  it("still trusts a user-owned Homebrew admin-group directory", () => {
    if (process.platform !== "darwin") return;
    const paths = temporaryPaths();
    const homebrewLib = path.join(paths.userHome, "opt-homebrew-lib");
    fs.mkdirSync(homebrewLib, { recursive: true, mode: 0o775 });
    fs.chmodSync(homebrewLib, 0o775);
    const adminGid = 80;
    const ownedByAdminGroup = fs.statSync(homebrewLib).gid === adminGid;
    fs.writeFileSync(path.join(homebrewLib, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    if (ownedByAdminGroup) {
      expect(findOriginalBinary("codex", paths, homebrewLib)).toBeDefined();
    } else {
      expect(findOriginalBinary("codex", paths, homebrewLib)).toBeUndefined();
    }
    cleanup(paths);
  });

  it("trusts a provider binary below a sticky world-writable ancestor", () => {
    const paths = temporaryPaths();
    const stickyAncestor = path.join(paths.userHome, "sticky-tmp");
    const providerBin = path.join(stickyAncestor, "provider-bin");
    fs.mkdirSync(providerBin, { recursive: true, mode: 0o700 });
    fs.chmodSync(stickyAncestor, 0o1777);
    fs.writeFileSync(path.join(providerBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(findOriginalBinary("codex", paths, providerBin)).toBeDefined();
    cleanup(paths);
  });

  it("rejects original binaries below a writable non-sticky ancestor", () => {
    const paths = temporaryPaths();
    const unsafeAncestor = path.join(paths.userHome, "unsafe-ancestor");
    const providerBin = path.join(unsafeAncestor, "provider-bin");
    fs.mkdirSync(providerBin, { recursive: true, mode: 0o700 });
    fs.chmodSync(unsafeAncestor, 0o770);
    fs.writeFileSync(path.join(providerBin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    expect(findOriginalBinary("codex", paths, providerBin)).toBeUndefined();
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
