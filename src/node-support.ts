import process from "node:process";

/** Node.js releases that ship the built-in node:sqlite module TokenPilot requires. Keep in sync with package.json engines. */
export const SUPPORTED_NODE_RANGE = "^22.13.0 || >=23.4.0";

export function isSupportedNodeVersion(version: string): boolean {
  const [major = Number.NaN, minor = Number.NaN] = version.replace(/^v/, "").split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major >= 24;
}

export function unsupportedNodeMessage(version: string): string {
  return `TokenPilot requires Node.js ${SUPPORTED_NODE_RANGE} (built-in node:sqlite); found ${version}. Upgrade Node.js and run the command again.\n`;
}

const SQLITE_WARNING_PREFIX = "SQLite is an experimental feature";

/** True only for Node's node:sqlite ExperimentalWarning; every other warning stays visible. */
export function isSqliteExperimentalWarning(warning: unknown, typeOrOptions?: unknown): boolean {
  const type = warning instanceof Error
    ? warning.name
    : typeof typeOrOptions === "string" ? typeOrOptions : (typeOrOptions as { type?: unknown } | undefined)?.type;
  const message = warning instanceof Error ? warning.message : warning;
  return type === "ExperimentalWarning" && typeof message === "string" && message.startsWith(SQLITE_WARNING_PREFIX);
}

/**
 * The installed launch shims set NODE_NO_WARNINGS; the npm-installed `tokenpilot` bin cannot pass
 * flags through its shebang, so drop only the node:sqlite experimental notice here.
 */
export function suppressSqliteExperimentalWarning(target: Pick<NodeJS.Process, "emitWarning"> = process): void {
  const original = target.emitWarning;
  target.emitWarning = function emitWarning(this: unknown, warning: unknown, ...rest: unknown[]) {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  } as NodeJS.Process["emitWarning"];
}
