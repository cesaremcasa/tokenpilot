import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageMetadata = {
  name: string;
  version: string;
  license: string;
  bin: Record<string, string>;
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
  private?: boolean;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  bundleDependencies?: string[];
};

type LockRoot = PackageMetadata & {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bundledDependencies?: string[];
  bundleDependencies?: string[];
};

const packageMetadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as PackageMetadata;
const packageLock = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
  lockfileVersion: number;
  packages: { "": LockRoot };
};

const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies"
] as const;

describe("package reproducibility contract", () => {
  it("keeps the npm lockfile at the supported v3 format and in sync at the root", () => {
    expect(packageLock.lockfileVersion).toBe(3);
    expect(packageLock.packages[""]).toMatchObject({
      name: packageMetadata.name,
      version: packageMetadata.version,
      license: packageMetadata.license,
      bin: packageMetadata.bin,
      engines: packageMetadata.engines,
      devDependencies: packageMetadata.devDependencies
    });
  });

  it("keeps the published package free of runtime dependencies", () => {
    const lockRoot = packageLock.packages[""];
    for (const field of runtimeDependencyFields) {
      const expected = field === "bundledDependencies" || field === "bundleDependencies" ? [] : {};
      expect(packageMetadata[field] ?? expected).toEqual(expected);
      expect(lockRoot[field] ?? expected).toEqual(expected);
    }
  });

  it("is explicitly ready for the public npm registry", () => {
    expect(packageMetadata.name).toBe("tokenpilot");
    expect(packageMetadata.private).not.toBe(true);
    expect(packageMetadata.publishConfig).toEqual({ access: "public" });
  });
});
