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
