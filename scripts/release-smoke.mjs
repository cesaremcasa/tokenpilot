import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSanitizedNpmEnvironment } from "./npm-environment.mjs";
import { expectedPackageFiles, validateTarball } from "./release-manifest.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-release-smoke-"));
const artifactDirectory = path.join(temporaryRoot, "artifacts");
const consumerDirectory = path.join(temporaryRoot, "consumer");
const npmEnvironment = createSanitizedNpmEnvironment(temporaryRoot);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}`);
  return result;
}

let installed;
try {
  assert.equal(npmEnvironment.NPM_TOKEN, undefined);
  assert(npmEnvironment.HOME.startsWith(temporaryRoot));
  assert(npmEnvironment.NPM_CONFIG_CACHE.startsWith(temporaryRoot));
  assert(npmEnvironment.NPM_CONFIG_USERCONFIG.startsWith(temporaryRoot));
  const artifact = JSON.parse(execFileSync(process.execPath, [path.join(repository, "scripts", "release-artifact.mjs"), "--output", artifactDirectory], { encoding: "utf8", env: npmEnvironment }));
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
  assert(!JSON.stringify(bom).includes(repository), "SBOM must not contain checkout paths");
  assert(!Object.hasOwn(bom.metadata, "timestamp"), "SBOM must not contain a generated timestamp");
  validateTarball(tarball, expectedPackageFiles(repository), path.join(temporaryRoot, "independent-tarball-scan"));

  function expectReleaseFailure(fixture, expectedMessage) {
    try {
      execFileSync(process.execPath, [path.join(repository, "scripts", "release-artifact.mjs"), "--repository", fixture, "--output", path.join(fixture, "output")], {
        encoding: "utf8",
        env: npmEnvironment,
        stdio: ["ignore", "pipe", "pipe"]
      });
      assert.fail(`Expected release artifact generation to fail for ${fixture}`);
    } catch (error) {
      if (error?.code === "ERR_ASSERTION") throw error;
      const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      assert.match(output, expectedMessage);
    }
  }

  function fixture(extraPath) {
    const directory = fs.mkdtempSync(path.join(temporaryRoot, "fixture-"));
    for (const file of ["package.json", "package-lock.json", "tsconfig.json", "CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md"]) {
      fs.copyFileSync(path.join(repository, file), path.join(directory, file));
    }
    fs.cpSync(path.join(repository, "src"), path.join(directory, "src"), { recursive: true });
    fs.cpSync(path.join(repository, "integrations"), path.join(directory, "integrations"), { recursive: true });
    fs.cpSync(path.join(repository, "dist"), path.join(directory, "dist"), { recursive: true });
    const stale = path.join(directory, extraPath);
    fs.mkdirSync(path.dirname(stale), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stale, "stale fixture content\n", { mode: 0o600 });
    return directory;
  }
  expectReleaseFailure(fixture("dist/stale-output.js"), /repository dist.*file manifest differs/);
  expectReleaseFailure(fixture("integrations/codex/tokenpilot/STALE.md"), /repository integrations.*file manifest differs/);

  fs.mkdirSync(consumerDirectory, { recursive: true, mode: 0o700 });
  run("npm", ["init", "--yes"], { cwd: consumerDirectory, env: npmEnvironment });
  run("npm", ["install", "--offline", "--ignore-scripts", "--no-save", tarball], { cwd: consumerDirectory, env: npmEnvironment });
  const installedRoot = path.join(consumerDirectory, "node_modules", packageMetadata.name);
  const installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installedPackage.version, packageMetadata.version);
  assert.notEqual(installedPackage.private, true);
  assert.equal(installedPackage.publishConfig?.access, "public");
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
