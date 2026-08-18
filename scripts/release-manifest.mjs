import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const STATIC_PACKAGE_FILES = ["CHANGELOG.md", "LICENSE", "README.md", "SECURITY.md", "package.json"];
export const INTEGRATION_FILES = [
  "integrations/claude/tokenpilot/SKILL.md",
  "integrations/codex/tokenpilot/SKILL.md",
  "integrations/codex/tokenpilot/agents/openai.yaml",
  "integrations/grok/tokenpilot/SKILL.md",
  "integrations/kimi/tokenpilot/SKILL.md"
];

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function walk(directory, relative = "", files = [], directories = []) {
  const entries = fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).sort((left, right) => compare(left.name, right.name));
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(directory, childRelative);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error(`Release input contains a symlink: ${childRelative}`);
    if (stat.isDirectory()) {
      directories.push(childRelative);
      walk(directory, childRelative, files, directories);
    } else if (stat.isFile() && stat.nlink === 1) {
      files.push(childRelative);
    } else {
      throw new Error(`Release input contains a special or hard-linked file: ${childRelative}`);
    }
  }
  return { files, directories };
}

export function assertDirectoryManifest(directory, expectedFiles, label) {
  assert(fs.existsSync(directory), `${label} is missing`);
  const expected = [...expectedFiles].sort(compare);
  const actual = walk(directory);
  assert.deepEqual(actual.files.sort(compare), expected, `${label} file manifest differs`);
  const expectedDirectories = new Set();
  for (const file of expected) {
    const segments = file.split(path.sep);
    for (let index = 1; index < segments.length; index += 1) expectedDirectories.add(segments.slice(0, index).join(path.sep));
  }
  assert(actual.directories.every((entry) => expectedDirectories.has(entry)), `${label} contains an unexpected directory`);
  return expected;
}

export function expectedDistFiles(repository) {
  const sourceRoot = path.join(repository, "src");
  const sourceFiles = walk(sourceRoot).files.filter((file) => file.endsWith(".ts")).sort(compare);
  return sourceFiles.flatMap((file) => {
    const target = file.slice(0, -3);
    return [`${target}.js`, `${target}.js.map`, `${target}.d.ts`].map((value) => path.join("dist", value));
  }).sort(compare);
}

export function expectedPackageFiles(repository) {
  return [
    ...STATIC_PACKAGE_FILES,
    ...expectedDistFiles(repository),
    ...INTEGRATION_FILES
  ].sort(compare);
}

export function validateTarball(tarball, expectedFiles, temporaryRoot) {
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const entry of listing) {
    assert(entry.startsWith("package/"), `Tarball entry has an unexpected root: ${entry}`);
    assert(!entry.includes("\0") && !entry.split("/").includes(".."), `Tarball entry has unsafe traversal: ${entry}`);
    assert(!path.isAbsolute(entry), `Tarball entry is absolute: ${entry}`);
  }
  const expectedEntries = expectedFiles.map((file) => `package/${file.replaceAll(path.sep, "/")}`).sort(compare);
  const fileEntries = listing.filter((entry) => !entry.endsWith("/"));
  assert.deepEqual(fileEntries.sort(compare), expectedEntries, "Tarball entries differ from the release manifest");

  const extraction = path.join(temporaryRoot, "tarball-extracted");
  fs.mkdirSync(extraction, { recursive: true, mode: 0o700 });
  execFileSync("tar", ["-xzf", tarball, "-C", extraction]);
  assertDirectoryManifest(path.join(extraction, "package"), expectedFiles, "extracted release");
  const secretPatterns = [
    /-----BEGIN [^-]+PRIVATE KEY-----/,
    /(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,})/,
    /AKIA[0-9A-Z]{16}/,
    /(?:^|[=:/])(?:\/Users\/|\/home\/|[A-Z]:\\\\Users\\\\)/m
  ];
  for (const file of expectedFiles) {
    const content = fs.readFileSync(path.join(extraction, "package", file), "utf8");
    for (const pattern of secretPatterns) assert(!pattern.test(content), `Tarball content matches a secret or host path pattern: ${file}`);
  }
}
