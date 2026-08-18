import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(repository, "package-lock.json"), "utf8"));
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (args.some((arg, index) => !["--output", outputIndex >= 0 && index === outputIndex + 1 ? arg : ""].includes(arg))) {
  throw new Error("Usage: npm run release:artifact -- [--output <directory>]");
}
if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error("--output requires a directory");

const outputDirectory = path.resolve(repository, outputIndex >= 0 ? args[outputIndex + 1] : "release-artifacts");
const packageRoot = packageLock.packages?.[""];
assert.equal(packageMetadata.name, "tokenpilot");
assert.equal(packageLock.name, packageMetadata.name);
assert.equal(packageLock.version, packageMetadata.version);
assert.equal(packageRoot?.name, packageMetadata.name);
assert.equal(packageRoot?.version, packageMetadata.version);
assert.equal(packageLock.lockfileVersion, 3);
assert.deepEqual(packageMetadata.dependencies ?? {}, {});
assert.deepEqual(packageMetadata.optionalDependencies ?? {}, {});
assert.deepEqual(packageMetadata.peerDependencies ?? {}, {});

function runPack(destination) {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const stdout = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" }
  });
  const records = JSON.parse(stdout.trim());
  const record = Array.isArray(records) ? records.at(-1) : records;
  assert.equal(record?.name, packageMetadata.name);
  assert.equal(record?.version, packageMetadata.version);
  assert.equal(record?.filename, `${packageMetadata.name}-${packageMetadata.version}.tgz`);
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
  const first = runPack(path.join(temporaryRoot, "first"));
  const second = runPack(path.join(temporaryRoot, "second"));
  const firstHash = sha256(first.tarball);
  const secondHash = sha256(second.tarball);
  assert.equal(firstHash, secondHash, "npm pack output is not deterministic");

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
