import fs from "node:fs";
import path from "node:path";

/** Build an npm environment that cannot reuse the caller's home, cache, logs, or credentials. */
export function createSanitizedNpmEnvironment(root) {
  const home = path.join(root, "npm-home");
  const cache = path.join(root, "npm-cache");
  const logs = path.join(root, "npm-logs");
  const userConfig = path.join(root, "npmrc");
  const globalConfig = path.join(root, "global-npmrc");
  for (const directory of [home, cache, logs]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const file of [userConfig, globalConfig]) fs.writeFileSync(file, "", { mode: 0o600 });

  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name === "NPM_TOKEN" || name === "NODE_AUTH_TOKEN" || /^npm_config_.*(?:auth|token|password|username|cert|key)/i.test(name)) {
      delete environment[name];
    }
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_LOGS_DIR: logs,
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_AUDIT: "false"
  });
  return environment;
}
