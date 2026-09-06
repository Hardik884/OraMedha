/**
 * lib/security/__tests__/security-txt.spec.ts
 *
 * The half of security.txt that matters is the half that refuses to publish.
 *
 * RFC 9116 makes Contact and Expires mandatory. A file with a made-up address
 * is worse than no file: a researcher who finds one stops looking for another
 * way to reach us, and reports into a mailbox nobody owns. So most of what is
 * asserted here is that nothing is emitted unless a real contact is configured.
 */

import { describe, it, expect, afterEach } from "vitest";
import { securityTxt } from "../security-txt";

const ORIGINAL = process.env.SECURITY_CONTACT;
const ORIGINAL_POLICY = process.env.SECURITY_POLICY_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SECURITY_CONTACT;
  else process.env.SECURITY_CONTACT = ORIGINAL;
  if (ORIGINAL_POLICY === undefined) delete process.env.SECURITY_POLICY_URL;
  else process.env.SECURITY_POLICY_URL = ORIGINAL_POLICY;
});

describe("securityTxt — refusing to invent a contact", () => {
  it("returns null when nothing is configured", () => {
    delete process.env.SECURITY_CONTACT;
    expect(securityTxt()).toBeNull();
  });

  it("returns null for an empty or whitespace value", () => {
    process.env.SECURITY_CONTACT = "   ";
    expect(securityTxt()).toBeNull();
  });

  it("rejects a value that is not a usable contact", () => {
    // A half-filled variable must produce no file, not a malformed one.
    for (const bad of [
      "security",
      "http://example.com/report", // not https
      "/report",
      "call us",
      "mailto:not-an-address",
    ]) {
      process.env.SECURITY_CONTACT = bad;
      expect(securityTxt(), `should reject ${bad}`).toBeNull();
    }
  });
});

describe("securityTxt — the file it does produce", () => {
  it("turns a bare address into a mailto: contact", () => {
    process.env.SECURITY_CONTACT = "security@example.test";
    expect(securityTxt()).toContain("Contact: mailto:security@example.test");
  });

  it("accepts an https reporting form as-is", () => {
    process.env.SECURITY_CONTACT = "https://example.test/report";
    expect(securityTxt()).toContain("Contact: https://example.test/report");
  });

  it("carries an Expires date in the future, in ISO 8601", () => {
    process.env.SECURITY_CONTACT = "security@example.test";
    const now = new Date("2026-01-01T00:00:00.000Z");
    const body = securityTxt(now)!;

    const match = body.match(/^Expires: (.+)$/m);
    expect(match).not.toBeNull();

    const expires = new Date(match![1]);
    expect(expires.getTime()).toBeGreaterThan(now.getTime());
    // RFC 9116 recommends under a year out.
    expect(expires.getTime() - now.getTime()).toBeLessThan(365 * 864e5);
    // No milliseconds — the RFC's examples use seconds precision.
    expect(match![1]).not.toMatch(/\.\d{3}Z$/);
  });

  it("omits Policy rather than guessing one", () => {
    process.env.SECURITY_CONTACT = "security@example.test";
    delete process.env.SECURITY_POLICY_URL;
    expect(securityTxt()).not.toContain("Policy:");

    process.env.SECURITY_POLICY_URL = "https://example.test/security";
    expect(securityTxt()).toContain("Policy: https://example.test/security");
  });

  it("has every field RFC 9116 requires", () => {
    process.env.SECURITY_CONTACT = "security@example.test";
    const body = securityTxt()!;
    expect(body).toMatch(/^Contact: /m);
    expect(body).toMatch(/^Expires: /m);
    expect(body.endsWith("\n")).toBe(true);
  });
});
