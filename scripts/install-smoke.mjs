import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-install-smoke-"));
const userHome = path.join(temporaryRoot, "home");
const artifactRoot = path.join(temporaryRoot, "artifact");

function mode(target) {
  return fs.statSync(target).mode & 0o777;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

let installed;
try {
  fs.mkdirSync(userHome, { mode: 0o700 });
  // Build a package-shaped artifact outside the checkout. This keeps the
  // smoke independent of mutable source files and exercises the same bundle
  // boundary used by a user installing the compiled CLI.
  fs.cpSync(path.join(repository, "dist"), path.join(artifactRoot, "dist"), { recursive: true });
  fs.cpSync(path.join(repository, "integrations"), path.join(artifactRoot, "integrations"), { recursive: true });

  const { getPaths } = await import(path.join(repository, "dist", "paths.js"));
  const { install, uninstall } = await import(path.join(repository, "dist", "installer.js"));
  const paths = getPaths({
    HOME: userHome,
    TOKENPILOT_HOME: path.join(userHome, ".tokenpilot"),
    TOKENPILOT_CONFIG_HOME: path.join(userHome, ".config", "tokenpilot"),
    TOKENPILOT_DATA_HOME: path.join(userHome, ".local", "share", "tokenpilot")
  }, { allowEnvironmentOverrides: true });
  const artifactCli = path.join(artifactRoot, "dist", "cli.js");

  installed = install(paths, {
    noShellConfig: true,
    noAgent: true,
    noSkills: true,
    executable: artifactCli,
    nodeExecutable: process.execPath
  });

  assert.equal(mode(paths.home), 0o700);
  assert.equal(mode(paths.runtimeDir), 0o700);
  assert.equal(mode(paths.shimDir), 0o700);
  assert.equal(installed.shims.length, 4);
  assert(installed.shims.every((shim) => fs.existsSync(shim)), "all provider shims must be installed");
  assert(fs.existsSync(installed.command), "the tokenpilot command shim must be installed");

  const commandShim = fs.readFileSync(installed.command, "utf8");
  assert(commandShim.includes(path.join(paths.runtimeDir, "releases")), "the command shim must target a private runtime release");
  assert(!commandShim.includes(artifactRoot), "the command shim must not retain the temporary artifact path");
  const releases = fs.readdirSync(path.join(paths.runtimeDir, "releases"));
  assert.equal(releases.length, 1, "a clean install must stage exactly one runtime release");

  // Remove the package-shaped artifact before invoking the installed command.
  // If this succeeds, the launchers are using the private runtime copy rather
  // than executing from a checkout that may later move or disappear.
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  const version = run(installed.command, ["--version"], {
    env: { ...process.env, HOME: userHome }
  });
  assert.equal(version.stdout, `tokenpilot ${packageMetadata.version}\n`);
  assert.equal(version.stderr, "");

  uninstall(paths);
  assert(!fs.existsSync(installed.command), "uninstall must remove the temporary command shim");
  assert(!fs.existsSync(installed.shims[0]), "uninstall must remove temporary provider shims");
  console.log("install smoke passed: compiled artifact staged, source removed, private runtime executed, and temporary state removed");
} finally {
  // The guard makes the cleanup target auditable and prevents a future edit
  // from turning this test into a broad recursive delete.
  assert(path.basename(temporaryRoot).startsWith("tokenpilot-install-smoke-"));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
