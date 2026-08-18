/** Keep synchronized with package.json when publishing a TokenPilot release. */
export const TOKENPILOT_VERSION = "0.4.17";

export function isVersionCommand(command: string | undefined): boolean {
  return command === "version" || command === "--version" || command === "-V";
}
