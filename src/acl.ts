import { spawnSync } from "node:child_process";

/**
 * Apple's default home ACL only prevents deletion. It is not a write grant
 * and must not block a normal macOS install.
 */
const SAFE_MAC_ACL = /^group:everyone deny delete$/;

/** Parse one `ls -le` ACL line. Deny-only entries are not write grants. */
export function isUnsafeMacAclEntry(line: string): boolean {
  const normalized = line.trim().replace(/^\d+:\s*/, "").toLowerCase();
  if (!normalized) return true;
  if (SAFE_MAC_ACL.test(normalized)) return false;
  const verbs = [...normalized.matchAll(/\b(allow|deny)\b/g)].map((match) => match[1]);
  return verbs.length === 0 || verbs.includes("allow");
}

/** macOS ACLs can grant writes even when POSIX mode bits are restrictive. */
export function hasUnsafeMacAcl(target: string): boolean {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/bin/ls", ["-lde", target], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return true;
  return result.stdout.trim().split(/\r?\n/).slice(1).some((line) => isUnsafeMacAclEntry(line));
}
