import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * This fork removed upstream's automated sign-in (a stored password plus a TOTP seed in
 * secrets.json). These pin that it stays removed.
 */
describe("sign-in", () => {
  it("exposes only interactive login — no credential loading or TOTP helpers", async () => {
    const exported = Object.keys(await import("./login.js")).sort();
    expect(exported).toEqual(["login"]);
  });

  it("never reads a secrets file, a password or a TOTP seed", () => {
    const source = readFileSync(new URL("./login.ts", import.meta.url), "utf8");
    // Comments may explain the removal; the code itself must not reference any of it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/SECRETS_FILE|secrets\.json|password|passwd|mfaSecret|totp|otpauth/i);
    expect(code).toMatch(/headless:\s*false/);
  });
});
