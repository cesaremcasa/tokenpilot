#!/usr/bin/env node
// Entry point: check the runtime before loading any module that imports node:sqlite,
// so unsupported Node.js versions get a clear message instead of a module-resolution stack trace.
import process from "node:process";
import { isSupportedNodeVersion, suppressSqliteExperimentalWarning, unsupportedNodeMessage } from "./node-support.js";

if (isSupportedNodeVersion(process.versions.node)) {
  suppressSqliteExperimentalWarning();
  await import("./main.js");
} else {
  process.stderr.write(unsupportedNodeMessage(process.versions.node));
  process.exitCode = 1;
}
