import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSanitizedNpmEnvironment } from "./npm-environment.mjs";
import { assertDirectoryManifest, expectedDistFiles, expectedPackageFiles, INTEGRATION_FILES, STATIC_PACKAGE_FILES, validateTarball } from "./release-manifest.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
const outputValue = option("--output");
const repositoryValue = option("--repository");
const allowedArgs = new Set(["--output", "--repository", outputValue, repositoryValue]);
if (args.some((arg) => !allowedArgs.has(arg))) throw new Error("Usage: npm run release:artifact -- [--output <directory>] [--repository <checkout>]");
const repository = path.resolve(repositoryValue ?? scriptRoot);
const packageMetadata = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(repository, "package-lock.json"), "utf8"));
const outputDirectory = path.resolve(repository, outputValue ?? "release-artifacts");
const packageRoot = packageLock.packages?.[""];
assert.equal(packageMetadata.name, "tokenpilot");
assert.equal(packageLock.name, packageMetadata.name);
assert.equal(packageLock.version, packageMetadata.version);
assert.equal(packageRoot?.name, packageMetadata.name);
assert.equal(packageRoot?.version, packageMetadata.version);
assert.equal(packageLock.lockfileVersion, 3);
assert.notEqual(packageMetadata.private, true);
assert.equal(packageMetadata.publishConfig?.access, "public");
assert.deepEqual(packageMetadata.dependencies ?? {}, {});
assert.deepEqual(packageMetadata.optionalDependencies ?? {}, {});
assert.deepEqual(packageMetadata.peerDependencies ?? {}, {});

let stagingCheckout;
let npmEnvironment;

function copySafe(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Release input contains a symlink: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(source)) copySafe(path.join(source, name), path.join(destination, name));
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Release input contains a special or hard-linked file: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
}

function stageCheckout(temporaryRoot) {
  const sourceDist = path.join(repository, "dist");
  if (fs.existsSync(sourceDist)) {
    assertDirectoryManifest(sourceDist, expectedDistFiles(repository).map((file) => file.slice("dist/".length)), "repository dist");
  }
  assertDirectoryManifest(path.join(repository, "integrations"), INTEGRATION_FILES.map((file) => file.slice("integrations/".length)), "repository integrations");
  const staging = path.join(temporaryRoot, "checkout");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", ...STATIC_PACKAGE_FILES]) {
    copySafe(path.join(repository, file), path.join(staging, file));
  }
  copySafe(path.join(repository, "src"), path.join(staging, "src"));
  for (const file of INTEGRATION_FILES) {
    copySafe(path.join(repository, file), path.join(staging, file));
  }
  return staging;
}

function runNpm(argumentsList, cwd) {
  execFileSync("npm", argumentsList, { cwd, encoding: "utf8", env: npmEnvironment });
}

function runPack(destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const stdout = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: stagingCheckout,
    encoding: "utf8",
    env: npmEnvironment
  });
  const records = JSON.parse(stdout.trim());
  const record = Array.isArray(records) ? records.at(-1) : records;
  assert.equal(record?.name, packageMetadata.name);
  assert.equal(record?.version, packageMetadata.version);
  assert.equal(record?.filename, `${packageMetadata.name}-${packageMetadata.version}.tgz`);
  const expectedFiles = expectedPackageFiles(stagingCheckout);
  assert.deepEqual(record?.files?.map((file) => file.path).sort(), expectedFiles, "npm pack file manifest differs");
  const tarball = path.join(destination, record.filename);
  assert(fs.existsSync(tarball), `npm pack did not create ${record.filename}`);
  return { tarball, record };
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function integrityHash(integrity) {
  if (typeof integrity !== "string") return undefined;
  const [algorithm, encoded] = integrity.split("-", 2);
  const normalized = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[algorithm];
  return normalized && encoded ? { alg: normalized, content: Buffer.from(encoded, "base64").toString("hex") } : undefined;
}

function packageName(location) {
  const marker = "node_modules/";
  return location.slice(location.lastIndexOf(marker) + marker.length);
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encodedName}@${version}`;
}

function buildBom() {
  const components = new Map();
  for (const [location, dependency] of Object.entries(packageLock.packages ?? {})) {
    if (!location.startsWith("node_modules/") || !dependency?.version || dependency.dev === true) continue;
    const name = packageName(location);
    const bomRef = npmPurl(name, dependency.version);
    if (components.has(bomRef)) continue;
    const component = {
      type: "library",
      "bom-ref": bomRef,
      name,
      version: dependency.version,
      purl: bomRef,
      ...(dependency.license ? { licenses: [{ license: dependency.license.includes(" ") ? { expression: dependency.license } : { id: dependency.license } }] } : {}),
      ...(dependency.integrity ? { hashes: [integrityHash(dependency.integrity)].filter(Boolean) } : {}),
      scope: dependency.dev ? "excluded" : dependency.optional ? "optional" : "required",
      properties: [
        { name: "npm:dev", value: dependency.dev ? "true" : "false" },
        { name: "npm:optional", value: dependency.optional ? "true" : "false" }
      ]
    };
    components.set(bomRef, component);
  }
  return {
    $schema: "https://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": npmPurl(packageMetadata.name, packageMetadata.version),
        name: packageMetadata.name,
        version: packageMetadata.version,
        purl: npmPurl(packageMetadata.name, packageMetadata.version)
      },
      properties: [
        { name: "npm:lockfileVersion", value: String(packageLock.lockfileVersion) },
        { name: "npm:runtimeDependencyCount", value: String(components.size) }
      ]
    },
    components: [...components.values()].sort((left, right) => left["bom-ref"] < right["bom-ref"] ? -1 : left["bom-ref"] > right["bom-ref"] ? 1 : 0)
  };
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tokenpilot-release-artifact-"));
try {
  npmEnvironment = createSanitizedNpmEnvironment(temporaryRoot);
  stagingCheckout = stageCheckout(temporaryRoot);
  runNpm(["ci", "--ignore-scripts"], stagingCheckout);
  runNpm(["run", "build"], stagingCheckout);
  assertDirectoryManifest(path.join(stagingCheckout, "dist"), expectedDistFiles(stagingCheckout).map((file) => file.slice("dist/".length)), "staging dist");
  const expectedFiles = expectedPackageFiles(stagingCheckout);
  const first = runPack(path.join(temporaryRoot, "first"));
  const second = runPack(path.join(temporaryRoot, "second"));
  const firstHash = sha256(first.tarball);
  const secondHash = sha256(second.tarball);
  assert.equal(firstHash, secondHash, "npm pack output is not deterministic");
  validateTarball(first.tarball, expectedFiles, path.join(temporaryRoot, "first-validation"));
  validateTarball(second.tarball, expectedFiles, path.join(temporaryRoot, "second-validation"));

  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(outputDirectory).length > 0) {
    throw new Error(`Release output directory must be empty: ${outputDirectory}`);
  }
  const filename = path.basename(first.tarball);
  const tarball = path.join(outputDirectory, filename);
  const checksum = `${tarball}.sha256`;
  const sbom = path.join(outputDirectory, `${packageMetadata.name}-${packageMetadata.version}.cdx.json`);
  fs.copyFileSync(first.tarball, tarball);
  fs.writeFileSync(checksum, `${firstHash}  ${filename}\n`, { mode: 0o600 });
  fs.writeFileSync(sbom, `${JSON.stringify(buildBom(), null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    version: packageMetadata.version,
    tarball,
    checksum,
    sbom,
    sha256: firstHash,
    deterministic: true
  }, null, 2));
} finally {
  assert(path.basename(temporaryRoot).startsWith("tokenpilot-release-artifact-"));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
