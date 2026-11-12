/**
 * Interactive sign-in. Loaded only by the CLI, never by the plugin.
 *
 * Why a browser at all: the Sydney scopes are granted exclusively to Microsoft's own
 * Office web Copilot client, so we cannot register a loopback redirect
 * (`AADSTS50011`) and the device-code grant is refused for that client
 * (`AADSTS7000218` — it wants a client secret only Microsoft has). The `nativeclient`
 * redirect is the only remaining door, and driving it needs a real browser.
 *
 * This fork signs in **interactively only**: a visible window where you complete
 * SSO/MFA yourself. Upstream also had an automated mode that typed a password and a
 * TOTP code generated from a seed, both read from `secrets.json`. It is removed: a file
 * holding both factors lets anyone who can read it pass MFA as you. A `secrets.json`
 * left over from upstream is never read (`opencode-m365 doctor` warns if it exists).
 *
 * Browser: one you already have. By default Microsoft Edge, then Google Chrome, then
 * Playwright's own Chromium if someone installed it explicitly (nothing here downloads
 * a browser). The app's Settings page can pin one; `M365_BROWSER_CHANNEL=msedge` (or
 * `chrome`) or `CHROMIUM_PATH=/path/to/browser` override both.
 *
 * Either way it is a one-time cost — afterwards `auth.ts` refreshes silently.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTHORITY, CLIENT_ID, REDIRECT_URI, SYDNEY_SCOPES, authCodeFromUrl, createCachePlugin } from "./auth.js";
import { createGuardedNetworkClient, withoutLibraryTelemetry } from "./egress.js";
import { CONFIG_DIR } from "./paths.js";
import { ensurePrivateDir } from "./private-fs.js";

export interface LoginOptions {
  cacheFile?: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
  /** Which installed browser to use: `auto` tries Edge, then Chrome. */
  browser?: "auto" | "msedge" | "chrome";
}

/**
 * Sign in and populate the MSAL cache.
 *
 * Returns the account username on success. Everything afterwards is silent refresh.
 */
export async function login(options: LoginOptions = {}): Promise<string> {
  const status = options.onStatus ?? (() => {});

  const { PublicClientApplication, CryptoProvider } = await import("@azure/msal-node");
  const app = new PublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    cache: { cachePlugin: createCachePlugin(options.cacheFile) },
    // Token traffic can only reach login.microsoftonline.com (see egress.ts).
    system: { networkClient: createGuardedNetworkClient() },
  });

  // PKCE: the verifier stays here, only its hash goes to the authorize endpoint.
  const { verifier, challenge } = await new CryptoProvider().generatePkceCodes();
  const authUrl = await app.getAuthCodeUrl({
    scopes: SYDNEY_SCOPES,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    prompt: "select_account",
  });

  status("Opening a browser window — complete sign-in there.");
  // MSAL adds its own name, version, OS and CPU to the sign-in address. Microsoft's
  // sign-in page does not need them, so they are taken off (see egress.ts).
  const code = await captureAuthCode(withoutLibraryTelemetry(new URL(authUrl)).toString(), options);

  const result = await app.acquireTokenByCode({
    code,
    scopes: SYDNEY_SCOPES,
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier,
  });

  return result?.account?.username ?? "signed in";
}

/** Open a visible browser on the authorize endpoint and pull the code off the redirect. */
async function captureAuthCode(authUrl: string, options: LoginOptions): Promise<string> {
  const playwright = await importPlaywright();
  const timeout = options.timeoutMs ?? 600_000;

  ensurePrivateDir(CONFIG_DIR);
  // A persistent profile keeps AAD's device cookies, so repeat logins are quiet and
  // look like a familiar device rather than a fresh unknown one every time.
  const profileDir = process.env.M365_BROWSER_PROFILE || join(CONFIG_DIR, "browser-profile");
  // It holds Entra SSO cookies.
  ensurePrivateDir(profileDir);

  const { context } = await launchBrowser(playwright, profileDir, options.browser ?? "auto");

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for sign-in to complete")), timeout);
      // The code lives on the navigation REQUEST. Waiting for the page to land
      // misses it — a real browser bounces straight on to /common/wrongplace.
      page.on("request", (request: { url(): string }) => {
        try {
          const found = authCodeFromUrl(request.url());
          if (found) {
            clearTimeout(timer);
            resolve(found);
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    });

    await page.goto(authUrl, { waitUntil: "domcontentloaded" }).catch(() => {
      /* navigation may be interrupted by the redirect we are racing for */
    });

    return await code;
  } finally {
    await context.close().catch(() => {});
  }
}

/** The browsers to try, in order. The environment wins, for anyone who set it. */
export function browserCandidates(choice: "auto" | "msedge" | "chrome"): { channel?: string; executablePath?: string; label: string }[] {
  if (process.env.CHROMIUM_PATH) return [{ executablePath: process.env.CHROMIUM_PATH, label: process.env.CHROMIUM_PATH }];
  if (process.env.M365_BROWSER_CHANNEL) return [{ channel: process.env.M365_BROWSER_CHANNEL, label: process.env.M365_BROWSER_CHANNEL }];
  if (choice === "msedge") return [{ channel: "msedge", label: "Microsoft Edge" }];
  if (choice === "chrome") return [{ channel: "chrome", label: "Google Chrome" }];
  return [
    { channel: "msedge", label: "Microsoft Edge" },
    { channel: "chrome", label: "Google Chrome" },
    // Only works if someone ran `npx playwright install chromium` on purpose.
    { label: "Playwright's Chromium" },
  ];
}

/**
 * The browser's own background services, pointed at a closed port on this machine.
 *
 * Playwright already starts the browser with most background traffic switched off, but
 * measured with Chrome 153, a sign-in window left open for 90 seconds still called
 * accounts.google.com (`/ListAccounts`), android.clients.google.com (`/checkin`, for
 * push messaging) and update.googleapis.com (component updates) on its own. These
 * switches send those three to 127.0.0.1:9, which never leaves the machine (browsers
 * skip any proxy for loopback); the same window then made no outside connection at all.
 *
 * Microsoft's sign-in page does not use any of them, so sign-in is unaffected. Edge
 * shares these switches with Chrome, but its own Microsoft services are separate and
 * follow your organization's Edge policies.
 */
export const QUIET_BROWSER_ARGS: readonly string[] = [
  "--gaia-url=https://127.0.0.1:9/",
  "--gcm-checkin-url=https://127.0.0.1:9/",
  "--gcm-registration-url=https://127.0.0.1:9/",
  "--gcm-mcs-endpoint=https://127.0.0.1:9/",
  "--component-updater=url-source=https://127.0.0.1:9/",
];

/** How the sign-in window is opened with one candidate browser. */
export function launchOptions(candidate: { channel?: string; executablePath?: string }, env: NodeJS.ProcessEnv = process.env) {
  return {
    headless: false,
    ...(candidate.channel ? { channel: candidate.channel } : {}),
    ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
    locale: env.M365_LOGIN_LOCALE || "en-GB",
    timezoneId: env.M365_LOGIN_TIMEZONE || undefined,
    ...(env.M365_LOGIN_UA ? { userAgent: env.M365_LOGIN_UA } : {}),
    args: [...QUIET_BROWSER_ARGS],
  };
}

async function launchBrowser(
  playwright: any,
  profileDir: string,
  choice: "auto" | "msedge" | "chrome",
  extra: { proxy?: { server: string }; args?: string[] } = {},
): Promise<{ context: any; label: string }> {
  const tried: string[] = [];
  for (const candidate of browserCandidates(choice)) {
    try {
      const options = launchOptions(candidate);
      const context = await playwright.chromium.launchPersistentContext(profileDir, {
        ...options,
        ...(extra.proxy ? { proxy: extra.proxy } : {}),
        args: [...options.args, ...(extra.args ?? [])],
      });
      return { context, label: candidate.label };
    } catch (error) {
      tried.push(`${candidate.label}: ${String((error as Error)?.message ?? error).split("\n")[0]}`);
    }
  }
  throw new Error(`Could not open a browser to sign in with. Install Microsoft Edge or Google Chrome, or pick another browser. Tried — ${tried.join("; ")}`);
}

export interface BrowserTraffic {
  /** The browser that was opened. */
  browser: string;
  /** Hosts the browser asked for on its own, and how many times. */
  hosts: Map<string, number>;
  /** Of those, the hosts that went around the refusing proxy (a policy can set the browser's proxy). */
  direct: Set<string>;
}

/**
 * What the sign-in browser contacts by itself, for `opencode-m365 doctor --browser`.
 *
 * Opens the browser exactly as sign-in does, but with a fresh throwaway profile, on an
 * empty page, for `seconds`. Its traffic goes to a proxy on this machine that notes
 * each host and refuses it, so nothing gets out that way. The browser's own network
 * log is read as well, because an organization's policy can give the browser a proxy
 * of its own, and then requests go around ours: those are reported as `direct`.
 */
export async function browserTraffic(options: { browser?: "auto" | "msedge" | "chrome"; seconds?: number } = {}): Promise<BrowserTraffic> {
  const playwright = await importPlaywright();
  const proxy = await startRefusingProxy();
  const profileDir = mkdtempSync(join(tmpdir(), "m365-browser-check-"));
  const netLog = join(profileDir, "net-log.json");
  try {
    const { context, label } = await launchBrowser(playwright, profileDir, options.browser ?? "auto", {
      proxy: { server: proxy.url },
      args: [`--log-net-log=${netLog}`, "--net-log-capture-mode=Default"],
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto("about:blank");
      await new Promise((done) => setTimeout(done, (options.seconds ?? 60) * 1000));
    } finally {
      await context.close().catch(() => {});
    }
    const hosts = new Map(proxy.hosts);
    const direct = new Set<string>();
    for (const host of hostsInNetLog(netLog)) {
      if (!hosts.has(host)) {
        direct.add(host);
        hosts.set(host, 1);
      }
    }
    return { browser: label, hosts, direct };
  } finally {
    await proxy.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

/** Remote hosts of the URLs in a browser network log (loopback and local pages left out). */
export function hostsInNetLog(path: string): Set<string> {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  const hosts = new Set<string>();
  for (const match of text.matchAll(/"url":"(https?:\/\/[^"\\]+)/g)) {
    try {
      const { hostname } = new URL(match[1]!);
      if (hostname && hostname !== "localhost" && !/^127\./.test(hostname) && hostname !== "[::1]") hosts.add(hostname);
    } catch {
      /* not a URL */
    }
  }
  return hosts;
}

/** A proxy on 127.0.0.1 that records the host of every request and refuses all of them. */
export async function startRefusingProxy(): Promise<{ url: string; hosts: Map<string, number>; close(): Promise<void> }> {
  const hosts = new Map<string, number>();
  const note = (host: string) => {
    if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
  };
  const server = createServer((request, response) => {
    let host = "";
    try {
      host = new URL(request.url ?? "").hostname;
    } catch {
      host = String(request.headers.host ?? "").replace(/:\d+$/, "");
    }
    note(host);
    response.writeHead(403).end();
  });
  server.on("connect", (request, socket) => {
    note(String(request.url ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, ""));
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hosts,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

/**
 * Load Playwright from **this checkout's own** `node_modules`, nowhere else.
 *
 * A bare `import("playwright")` walks every `node_modules` in every parent directory, so
 * a package planted anywhere up the tree would run during sign-in. Resolution is pinned
 * to the checkout (the directory above `dist/`, or above `src/` in tests) and the result
 * must really live inside it.
 */
async function importPlaywright(): Promise<any> {
  const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const requireFromCheckout = createRequire(join(checkout, "package.json"));
  let entry: string;
  try {
    entry = requireFromCheckout.resolve("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed in this checkout. It is an optional peer dependency, deliberately not pulled in by the plugin itself. " +
        "From the checkout directory run `npm i --no-save --ignore-scripts playwright`, then either point it at a browser you already " +
        "have (M365_BROWSER_CHANNEL=msedge or chrome, or CHROMIUM_PATH=/path/to/browser) or download Playwright's Chromium explicitly " +
        "with `npx playwright install chromium`.",
    );
  }
  const root = realpathSync(checkout);
  const real = realpathSync(entry);
  if (!real.startsWith(`${root}${sep}`)) {
    throw new Error(`Refusing to load Playwright from ${real}: it must be installed inside this checkout (${root}).`);
  }
  return requireFromCheckout("playwright");
}
