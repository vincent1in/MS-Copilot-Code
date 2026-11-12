import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * This fork removed upstream's automated sign-in (a stored password plus a TOTP seed in
 * secrets.json). These pin that it stays removed.
 */
describe("sign-in", () => {
  it("exposes only interactive login — no credential loading or TOTP helpers", async () => {
    const exported = Object.keys(await import("./login.js")).sort();
    expect(exported).toEqual([
      "QUIET_BROWSER_ARGS",
      "browserCandidates",
      "browserTraffic",
      "hostsInNetLog",
      "launchOptions",
      "login",
      "startRefusingProxy",
    ]);
  });

  it("checks the browser's own traffic behind a proxy that records each host and lets nothing through", async () => {
    const { startRefusingProxy } = await import("./login.js");
    const { request } = await import("node:http");
    const proxy = await startRefusingProxy();
    const port = Number(new URL(proxy.url).port);
    try {
      const connect = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: "accounts.example.invalid:443" });
        req.on("connect", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      const plain = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "GET", path: "http://update.example.invalid/check" }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect([connect, plain]).toEqual([403, 403]);
      expect(Object.fromEntries(proxy.hosts)).toEqual({ "accounts.example.invalid": 1, "update.example.invalid": 1 });
    } finally {
      await proxy.close();
    }
  });

  it("reads remote hosts out of a browser network log, leaving out this machine", async () => {
    const { hostsInNetLog } = await import("./login.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const file = join(mkdtempSync(join(tmpdir(), "netlog-")), "net-log.json");
    writeFileSync(
      file,
      JSON.stringify({
        events: [
          { params: { url: "https://accounts.example.invalid/ListAccounts?gpsia=1" } },
          { params: { url: "https://127.0.0.1:9/" } },
          { params: { url: "http://localhost:4141/health" } },
          { params: { url: "about:blank" } },
          { params: { url: "https://update.example.invalid/service/update2/json" } },
        ],
      }),
    );
    expect([...hostsInNetLog(file)].sort()).toEqual(["accounts.example.invalid", "update.example.invalid"]);
    expect(hostsInNetLog(join(file, "missing")).size).toBe(0);
  });

  it("opens the sign-in window with the browser's own background services pointed at this machine", async () => {
    const { QUIET_BROWSER_ARGS, launchOptions } = await import("./login.js");
    const options = launchOptions({ channel: "chrome" }, {});
    expect(options).toMatchObject({ headless: false, channel: "chrome", locale: "en-GB", handleSIGTERM: false, handleSIGHUP: false });
    expect(options.args).toEqual([...QUIET_BROWSER_ARGS]);
    // Google's account check, push-messaging check-in and component updates: the three
    // services measured calling out from a sign-in window on their own.
    const switches = QUIET_BROWSER_ARGS.map((arg) => arg.slice(2, arg.indexOf("=")));
    expect(switches).toEqual(["gaia-url", "gcm-checkin-url", "gcm-registration-url", "gcm-mcs-endpoint", "component-updater"]);
    for (const arg of QUIET_BROWSER_ARGS) {
      const url = new URL(arg.slice(arg.lastIndexOf("=") + 1));
      expect(url.hostname, arg).toBe("127.0.0.1");
    }
  });

  it("signs in with a browser you already have: Edge, then Chrome, unless one is chosen", async () => {
    const { browserCandidates } = await import("./login.js");
    const saved = { channel: process.env.M365_BROWSER_CHANNEL, path: process.env.CHROMIUM_PATH };
    delete process.env.M365_BROWSER_CHANNEL;
    delete process.env.CHROMIUM_PATH;
    try {
      expect(browserCandidates("auto").map((candidate) => candidate.channel)).toEqual(["msedge", "chrome", undefined]);
      expect(browserCandidates("chrome")).toEqual([{ channel: "chrome", label: "Google Chrome" }]);
      process.env.M365_BROWSER_CHANNEL = "msedge-beta";
      expect(browserCandidates("chrome")).toEqual([{ channel: "msedge-beta", label: "msedge-beta" }]);
    } finally {
      if (saved.channel === undefined) delete process.env.M365_BROWSER_CHANNEL;
      else process.env.M365_BROWSER_CHANNEL = saved.channel;
      if (saved.path === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = saved.path;
    }
  });

  it("never reads a secrets file, a password or a TOTP seed", () => {
    const source = readFileSync(new URL("./login.ts", import.meta.url), "utf8");
    // Comments may explain the removal; the code itself must not reference any of it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/SECRETS_FILE|secrets\.json|password|passwd|mfaSecret|totp|otpauth/i);
    expect(code).toMatch(/headless:\s*false/);
  });

  it("loads Playwright only from this checkout, never by a bare import that walks parent directories", () => {
    const source = readFileSync(new URL("./login.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/import\(\s*["']playwright["']\s*\)/);
    expect(code).toMatch(/createRequire\(join\(checkout, "package\.json"\)\)/);
    expect(code).toMatch(/realpathSync\(entry\)/);
  });
});
