import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { install, uninstall } from "../src/installer.js";
import { findOriginalBinary, isPassthrough } from "../src/launcher.js";
import { cleanup, temporaryPaths } from "./helpers.js";

describe("installation and fail-open launcher lookup", () => {
  it("creates removable per-provider shims without changing the shell when requested", () => {
    const paths = temporaryPaths();
    const plan = install(paths, { noShellConfig: true, noAgent: true, executable: "/opt/tokenpilot/dist/cli.js", nodeExecutable: "/usr/local/bin/node" });
    expect(plan.shims).toHaveLength(4);
    const shim = fs.readFileSync(path.join(paths.shimDir, "codex"), "utf8");
    expect(shim).toContain("__shim codex");
    expect(shim).toContain("TOKENPILOT_SHIM_DIR");
    uninstall(paths);
    expect(fs.existsSync(path.join(paths.shimDir, "codex"))).toBe(false);
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
    expect(isPassthrough([])).toBe(false);
    cleanup(paths);
  });
});
