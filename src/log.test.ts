import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = (path: string) => statSync(path).mode & 0o777;

describe.runIf(process.platform !== "win32")("the debug log", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The logger reads its switches and paths at import, so each test imports it fresh.
  async function freshLogger(dir: string) {
    vi.stubEnv("M365_DEBUG", "1");
    vi.stubEnv("M365_LOG_STDOUT", "");
    vi.stubEnv("M365_CONFIG_DIR", dir);
    vi.resetModules();
    const { createLogger } = await import("./log.js");
    return createLogger("test");
  }

  it("creates the log owner-only and sets it up only on the first line", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "m365-log-")), "config");
    const log = await freshLogger(dir);
    log.info("first");
    const file = join(dir, "debug.log");
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);

    // Every later line is a plain append: a chmod per line would pull these back.
    chmodSync(file, 0o644);
    chmodSync(dir, 0o755);
    log.warn("second");
    expect(mode(file)).toBe(0o644);
    expect(mode(dir)).toBe(0o755);
    expect(readFileSync(file, "utf8")).toMatch(/\[info\] \[test\] first\n.*\[warn\] \[test\] second\n$/);
  });
});

describe("redaction", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJvaWQiOiJhYmNkZWZnaCJ9.c2lnbmF0dXJlLXZhbHVl";

  it("strips tokens from anything that is logged", async () => {
    const { redact } = await import("./log.js");
    const line = redact(
      `wss://substrate.office.com/m365Copilot/Chathub/a@b?access_token=${jwt}&ConversationId=c ` +
        `Authorization: Bearer abc.def-ghi {"refresh_token":"0.AAAA-secret","note":"kept"} raw ${jwt}`,
    );
    expect(line).not.toContain(jwt);
    expect(line).not.toContain("abc.def-ghi");
    expect(line).not.toContain("0.AAAA-secret");
    expect(line).toContain("access_token=[REDACTED]&ConversationId=c");
    expect(line).toContain('"note":"kept"');
  });

  it.each([
    ["a form body", "grant_type=refresh_token&refresh_token=0.AAAA-opaque&client_id=x", "0.AAAA-opaque"],
    ["a form body that starts with it", "refresh_token=0.AAAA-opaque&x=1", "0.AAAA-opaque"],
    ["the sign-in redirect's code", "https://login.microsoftonline.com/common/oauth2/nativeclient?code=0.AWA-code&state=s", "0.AWA-code"],
    ["JSON-escaped fields inside a logged reply", String.raw`{"reply":"{\"secret\":\"0.AAAA-escaped\"}"}`, "0.AAAA-escaped"],
    ["camelCase token fields", `{"accessToken":"opaque-value","refreshToken":"0.BBBB"}`, "opaque-value"],
    ["an encrypted (JWE) token", "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..aXYtdmFsdWUtaGVyZQ.Y2lwaGVydGV4dC1oZXJl.dGFnLXZhbHVl", "Y2lwaGVydGV4dC1oZXJl"],
  ])("covers %s", async (_what, input, secret) => {
    const { redact } = await import("./log.js");
    expect(redact(input)).not.toContain(secret);
  });

  it("leaves ordinary text alone", async () => {
    const { redact } = await import("./log.js");
    const prose = "exit code=1, the code: ok, status 200, eyJ alone";
    expect(redact(prose)).toBe(prose);
  });

  it("runs in linear time on adversarial input (it runs on opencode's event loop)", async () => {
    const { redact } = await import("./log.js");
    const inputs = [
      "eyJ".repeat(100_000),
      `${"eyJabcdefghij.".repeat(20_000)}`,
      String.raw`"secret\\\"`.repeat(20_000),
      "Bearer ".repeat(40_000),
      "?code=&".repeat(40_000),
      "\n".repeat(200_000),
    ];
    const started = performance.now();
    for (const input of inputs) redact(input);
    // The unanchored pattern this replaced took ~31 s on 200 KB of "eyJ".
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it.runIf(process.platform !== "win32")("applies to the debug log file, even under M365_TRACE", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "m365-log-")), "config");
    vi.stubEnv("M365_DEBUG", "1");
    vi.stubEnv("M365_TRACE", "1");
    vi.stubEnv("M365_LOG_STDOUT", "");
    vi.stubEnv("M365_CONFIG_DIR", dir);
    vi.resetModules();
    try {
      const { createLogger } = await import("./log.js");
      createLogger("test").info("url", "wss://x/?access_token=eyJabcdefghij.eyJklmnopqrs.sig&y=1");
      const text = readFileSync(join(dir, "debug.log"), "utf8");
      expect(text).toContain("access_token=[REDACTED]");
      expect(text).not.toContain("eyJabcdefghij");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
