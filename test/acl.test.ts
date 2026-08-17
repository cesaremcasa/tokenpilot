import { describe, expect, it } from "vitest";
import { isUnsafeMacAclEntry } from "../src/acl.js";

describe("macOS ACL admission", () => {
  it("accepts Apple's default home deny-delete ACL", () => {
    expect(isUnsafeMacAclEntry(" 0: group:everyone deny delete")).toBe(false);
    expect(isUnsafeMacAclEntry("group:everyone deny delete")).toBe(false);
  });

  it("accepts other deny-only entries", () => {
    expect(isUnsafeMacAclEntry(" 1: user:nobody deny write,delete")).toBe(false);
  });

  it("refuses write-granting and unknown allow entries", () => {
    expect(isUnsafeMacAclEntry(" 0: group:everyone allow write")).toBe(true);
    expect(isUnsafeMacAclEntry(" 0: user:nobody allow add_file,delete_child")).toBe(true);
    expect(isUnsafeMacAclEntry(" 0: user:nobody allow read")).toBe(true);
    expect(isUnsafeMacAclEntry("")).toBe(true);
    expect(isUnsafeMacAclEntry("not-an-acl")).toBe(true);
  });
});
