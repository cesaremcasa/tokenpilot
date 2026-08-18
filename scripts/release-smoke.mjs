import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-release-smoke-"));
const artifactDirectory = path.join(temporaryRoot, "artifacts");
const consumerDirectory = path.join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

let installed;
try {
  const artifact = JSON.parse(execFileSync(process.execPath, [path.join(repository, "scripts", "release-artifact.mjs"), "--output", artifactDirectory], { encoding: "utf8" }));
  const tarball = artifact.tarball;
  const checksumLine = fs.readFileSync(artifact.checksum, "utf8");
  const expectedHash = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  assert.equal(checksumLine, `${expectedHash}  ${path.basename(tarball)}\n`);
  assert.equal(artifact.sha256, expectedHash);
  const bom = JSON.parse(fs.readFileSync(artifact.sbom, "utf8"));
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.equal(bom.metadata.component.version, packageMetadata.version);
  assert.equal(bom.metadata.properties.find((property) => property.name === "npm:runtimeDependencyCount")?.value, "0");
  assert.deepEqual(bom.components.map((component) => component["bom-ref"]), [...bom.components].map((component) => component["bom-ref"]).sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
  assert(!JSON.stringify(bom).includes(temporaryRoot), "SBOM must not contain host-specific temp paths");
  assert(!Object.hasOwn(bom.metadata, "timestamp"), "SBOM must not contain a generated timestamp");

  fs.mkdirSync(consumerDirectory, { recursive: true, mode: 0o700 });
  run("npm", ["init", "--yes"], { cwd: consumerDirectory, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" } });
  run("npm", ["install", "--ignore-scripts", "--no-save", tarball], { cwd: consumerDirectory, env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" } });
  const installedRoot = path.join(consumerDirectory, "node_modules", packageMetadata.name);
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedPackage.version, packageMetadata.version);
  const installedCli = path.join(installedRoot, "dist", "cli.js");
  const installedCommand = path.join(consumerDirectory, "node_modules", ".bin", "tokenpilot");
  assert.equal(run(installedCommand, ["--version"], { cwd: consumerDirectory, env: { ...process.env, NODE_NO_WARNINGS: "1" } }).stdout, `tokenpilot ${packageMetadata.version}\n`);

  const { getPaths } = await import(pathToFileURL(path.join(installedRoot, "dist", "paths.js")).href);
  const { install, uninstall } = await import(pathToFileURL(path.join(installedRoot, "dist", "installer.js")).href);
  const userHome = path.join(temporaryRoot, "home");
  fs.mkdirSync(userHome, { mode: 0o700 });
  const paths = getPaths({
    HOME: userHome,
    TOKENPILOT_HOME: path.join(userHome, ".tokenpilot"),
    TOKENPILOT_CONFIG_HOME: path.join(userHome, ".config", "tokenpilot"),
    TOKENPILOT_DATA_HOME: path.join(userHome, ".local", "share", "tokenpilot")
  }, { allowEnvironmentOverrides: true });
  installed = install(paths, { noShellConfig: true, noAgent: true, noSkills: true, executable: installedCli, nodeExecutable: process.execPath });
  const commandShim = fs.readFileSync(installed.command, "utf8");
  assert(commandShim.includes(path.join(paths.runtimeDir, "releases")));
  assert(!commandShim.includes(installedRoot), "installed launchers must not execute from the npm consumer tree");

  // Remove the real npm-installed package before invoking the staged runtime.
  fs.rmSync(installedRoot, { recursive: true, force: true });
  assert.equal(run(installed.command, ["--version"], { env: { ...process.env, HOME: userHome } }).stdout, `tokenpilot ${packageMetadata.version}\n`);
  uninstall(paths);
  assert(!fs.existsSync(installed.command), "tarball install uninstall must remove the command shim");
  assert(!fs.existsSync(installed.shims[0]), "tarball install uninstall must remove provider shims");
  console.log("release smoke passed: real npm tarball checksum/SBOM verified, installed, executed after source removal, and uninstalled");
} finally {
  assert(path.basename(temporaryRoot).startsWith("tokenpilot-release-smoke-"));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
