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
 * Browser: by default Playwright's bundled Chromium, which must already be installed
 * (`npx playwright install chromium` downloads it — an explicit, separate step; nothing
 * here downloads anything). To use a browser you already have instead, set
 * `M365_BROWSER_CHANNEL=msedge` (or `chrome`), or `CHROMIUM_PATH` to its executable.
 *
 * Either way it is a one-time cost — afterwards `auth.ts` refreshes silently.
 */

import { join } from "node:path";
import { AUTHORITY, CLIENT_ID, REDIRECT_URI, SYDNEY_SCOPES, authCodeFromUrl, createCachePlugin } from "./auth.js";
import { createGuardedNetworkClient } from "./egress.js";
import { CONFIG_DIR } from "./paths.js";
import { ensurePrivateDir } from "./private-fs.js";

export interface LoginOptions {
  cacheFile?: string;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
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
  const code = await captureAuthCode(authUrl, options);

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

  const context = await playwright.chromium.launchPersistentContext(profileDir, {
    headless: false,
    ...(process.env.M365_BROWSER_CHANNEL ? { channel: process.env.M365_BROWSER_CHANNEL } : {}),
    executablePath: process.env.CHROMIUM_PATH || undefined,
    locale: process.env.M365_LOGIN_LOCALE || "en-GB",
    timezoneId: process.env.M365_LOGIN_TIMEZONE || undefined,
    ...(process.env.M365_LOGIN_UA ? { userAgent: process.env.M365_LOGIN_UA } : {}),
  });

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

async function importPlaywright(): Promise<any> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. It is an optional peer dependency, deliberately not pulled in by the plugin itself. " +
        "Install it next to this checkout with `npm i --no-save --ignore-scripts playwright`, then either point it at a " +
        "browser you already have (M365_BROWSER_CHANNEL=msedge or chrome, or CHROMIUM_PATH=/path/to/browser) or download " +
        "Playwright's Chromium explicitly with `npx playwright install chromium`.",
    );
  }
}
