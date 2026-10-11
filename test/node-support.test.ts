import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isSupportedNodeVersion, SUPPORTED_NODE_RANGE, unsupportedNodeMessage } from "../src/node-support.js";

describe("Node.js runtime guard", () => {
  it("accepts exactly the engines range", () => {
    for (const version of ["22.13.0", "22.20.1", "23.4.0", "23.11.1", "24.0.0", "26.1.0", "v24.21.0"]) {
      expect(isSupportedNodeVersion(version)).toBe(true);
    }
    for (const version of ["20.19.2", "22.12.0", "23.3.0", "18.20.8", "", "abc"]) {
      expect(isSupportedNodeVersion(version)).toBe(false);
    }
  });

  it("matches package.json engines", () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { engines: { node: string } };
    expect(metadata.engines.node).toBe(SUPPORTED_NODE_RANGE);
  });

  it("names the required range and the found version", () => {
    const message = unsupportedNodeMessage("20.19.2");
    expect(message).toContain(SUPPORTED_NODE_RANGE);
    expect(message).toContain("20.19.2");
  });
});
