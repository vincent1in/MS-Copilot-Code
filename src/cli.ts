#!/usr/bin/env node
/**
 * `opencode-m365` — the gateway's command line.
 *
 * `start` is the front door: it runs the gateway with its page and opens it, and the
 * page walks you through signing in, a test message, and connecting OpenCode. The
 * other commands do the same steps from a terminal, or check the plumbing.
 *
 * Signing in opens a browser window, which a plugin running under OpenCode's TUI must
 * not do; that is why it lives here (and in the app), not in the plugin.
 */

import { existsSync } from "node:fs";
import { createTokenClient } from "./auth.js";
import { PROVIDER_ID } from "./config.js";
import { ALLOWED_HOSTS } from "./egress.js";
import { checkTones, distinctTones } from "./live-check.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL, MODELS } from "./models.js";
import { createAppController } from "./monitor/app.js";
import { launchPage, type LaunchedPage } from "./monitor/launch.js";
import { listMonitorLinks } from "./monitor/links.js";
import { createMonitor } from "./monitor/monitor.js";
import { openInBrowser } from "./open-url.js";
import { connectOpenCode, openCodeStatus } from "./opencode-config.js";
import { CACHE_FILE, CONFIG_DIR, SECRETS_FILE } from "./paths.js";
import { startServer } from "./server.js";
import { CopilotSession } from "./session.js";
import { createSettingsStore, type SettingState } from "./settings.js";

const DEFAULT_PORT = 4141;

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);

  switch (command) {
    case "start":
      return doStart(rest);
    case "open":
      return doOpen();
    case "login":
      return doLogin();
    case "setup":
      return doSetup(rest);
    case "serve":
      return doServe(rest);
    case "monitor":
      return doMonitor();
    case "doctor":
      return doDoctor(rest);
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`opencode-m365 — use your work account's Microsoft Copilot as OpenCode's model

  start [--port <n>] [--no-open]
                  Start the gateway and open its page, which walks you through
                  signing in, a test message and connecting OpenCode (port ${DEFAULT_PORT})
  open            Open the page of a gateway that is already running
  login           Sign in to Microsoft 365 in a browser window (SSO/MFA by hand)
  setup [--quiet] Add this folder to OpenCode's config for you (the page shows how
                  to do it by hand); --quiet also turns off OpenCode's own update
                  checks, session sharing and web search
  serve [--port <n>] [--monitor]
                  Run only the OpenAI-compatible proxy, for scripts
                  (key from M365_PROXY_KEY, else printed); --monitor adds the page
  monitor         Print the page link of every running gateway
  doctor [--live] [--browser [--seconds <n>]]
                  Check sign-in, the proxy and OpenCode (read-only). --live also
                  sends one short message per model; --browser opens the sign-in
                  browser on an empty page for a minute and lists what it tries to
                  contact by itself (refused, not sent)

Your settings and sign-in live in ${CONFIG_DIR} (readable only by you).
The gateway contacts exactly two addresses: ${ALLOWED_HOSTS.auth} (sign-in)
and ${ALLOWED_HOSTS.chat} (Copilot). Nothing else, and no analytics.`);
}

async function doStart(args: string[]): Promise<void> {
  const port = portFrom(args) ?? DEFAULT_PORT;
  const settings = createSettingsStore();
  const tokens = createTokenClient();
  const monitor = createMonitor();
  const fixedKey = process.env.M365_PROXY_KEY || undefined;

  let proxy: Awaited<ReturnType<typeof startServer>>;
  try {
    proxy = await startServer({
      getToken: () => tokens.getToken(),
      settings: () => settings.current(),
      monitor,
      port,
      ...(fixedKey ? { apiKey: fixedKey } : {}),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
    const running = listMonitorLinks().find((entry) => new URL(entry.proxy).port === String(port));
    if (running) {
      console.log(`The gateway is already running (process ${running.pid}). Its page:\n  ${running.link}`);
      if (!args.includes("--no-open")) openInBrowser(running.link);
      return;
    }
    console.error(`Port ${port} is in use by another program. Start on another one: opencode-m365 start --port ${port + 1}`);
    process.exitCode = 1;
    return;
  }

  const facts = { context: "app" as const, proxy: proxy.url, pid: process.pid, defaultModel: DEFAULT_MODEL, startedAt: new Date().toISOString() };
  const app = createAppController({
    context: "app",
    facts,
    tokens,
    settings,
    proxy: { url: proxy.url, apiKey: proxy.apiKey },
    signIn: async (browser) => {
      // Imported here so the browser automation only loads when someone signs in.
      const { login } = await import("./login.js");
      return login({ browser });
    },
  });
  const page = await launchPage({ monitor, facts, app, open: !args.includes("--no-open") });

  console.log("The gateway is running.");
  console.log(`\n  ${page.opened ? "Its page should open in your browser. If it does not, open" : "Open"} this link:`);
  console.log(`  ${page.link}`);
  console.log("\n  The link is the key to the page: don't share it.");
  console.log("  Ctrl+C stops the gateway. OpenCode runs its own copy of the gateway, so it");
  console.log("  does not need this window once you are set up.");
  stopOnSignal([page, proxy]);
}

function doOpen(): void {
  const [newest] = listMonitorLinks();
  if (!newest) {
    console.log("No gateway with a page is running.");
    console.log('Start one with `opencode-m365 start`, or turn on "Start this page with OpenCode" in its Settings.');
    return;
  }
  console.log(`Opening the page of gateway ${newest.pid}:\n  ${newest.link}`);
  openInBrowser(newest.link);
}

async function doLogin(): Promise<void> {
  // Imported here so the heavy browser dependency never loads for other commands.
  const { login } = await import("./login.js");
  try {
    const account = await login({
      browser: createSettingsStore().current().signInBrowser,
      onStatus: (message) => console.log(`  ${message}`),
    });
    console.log(`\nSigned in as ${account}.`);
    console.log(`Token cache written to ${CACHE_FILE}`);
    console.log("\nNext: send a test message and connect OpenCode — opencode-m365 start");
  } catch (error) {
    console.error(`\nSign-in failed: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function doSetup(args: string[]): void {
  // Always this checkout, referenced by its directory (opencode 2 refuses a file path).
  // Upstream defaulted to the npm name, which makes opencode install the published
  // upstream package — code nobody here reviewed — on its next start. `--local` is
  // accepted and ignored.
  try {
    const quiet = args.includes("--quiet");
    const result = connectOpenCode({ quiet });
    console.log(`Connected: OpenCode now loads the gateway from this folder (${result.configPath}).`);
    if (result.removedLegacyEntry) console.log("(Removed this plugin's old opencode 1 entry: opencode 1 is no longer supported.)");
    if (result.backupPath) console.log(`(Your previous config is saved as ${result.backupPath}.)`);
    if (quiet) console.log("OpenCode's own update checks, session sharing and web search are off.");
    console.log("\nStart OpenCode in your project with `opencode`. Models from the gateway are");
    console.log(`listed as ${PROVIDER_ID}/<model>, and ${PROVIDER_ID}/${DEFAULT_MODEL} is used when you pick none.`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

async function doServe(args: string[]): Promise<void> {
  const port = portFrom(args) ?? DEFAULT_PORT;
  const settings = createSettingsStore();
  const tokens = createTokenClient();
  // A fixed key lets a long-lived client config keep working across restarts;
  // otherwise every launch mints a fresh one.
  const fixedKey = process.env.M365_PROXY_KEY || undefined;
  const monitor = args.includes("--monitor") ? createMonitor() : undefined;
  const proxy = await startServer({
    getToken: () => tokens.getToken(),
    settings: () => settings.current(),
    ...(monitor ? { monitor } : {}),
    port,
    ...(fixedKey ? { apiKey: fixedKey } : {}),
  });
  let page: LaunchedPage | undefined;
  if (monitor) {
    const facts = { context: "app" as const, proxy: proxy.url, pid: process.pid, defaultModel: DEFAULT_MODEL, startedAt: new Date().toISOString() };
    const app = createAppController({ context: "app", facts, tokens, settings, proxy: { url: proxy.url, apiKey: proxy.apiKey } });
    page = await launchPage({ monitor, facts, app });
  }

  const current = settings.current();
  console.log(`M365 Copilot proxy listening on ${proxy.url}`);
  console.log(`  models:      ${proxy.url}/v1/models`);
  console.log(`  completions: ${proxy.url}/v1/chat/completions`);
  console.log(`  web search:  ${current.webSearch ? "on" : "off — Copilot is not offered Bing on coding turns"}`);
  console.log(`  work data:   ${describeWorkIq(current.workIq)}`);
  console.log(`  page:        ${page ? page.link : "off — add --monitor to see every turn"}`);
  console.log("\nLoopback-only. Every request must send `Authorization: Bearer <key>`;");
  console.log("browser origins and CORS are refused.");
  if (fixedKey) {
    console.log("  key:         from M365_PROXY_KEY");
  } else {
    console.log(`  key:         ${proxy.apiKey}`);
    console.log("               (new every launch — set M365_PROXY_KEY to keep one)");
  }
  console.log("Ctrl+C to stop.");
  stopOnSignal([page, proxy]);
}

function describeWorkIq(policy: string): string {
  if (policy === "hold") return "held — a reply Copilot drew from your email, files or chats never reaches the client";
  if (policy === "flag") return "flagged — such replies pass through and are marked on the page";
  return "allowed — such replies pass through";
}

function doMonitor(): void {
  const links = listMonitorLinks();
  if (links.length === 0) {
    console.log("No gateway with a page is running. Start one with `opencode-m365 start`.");
    return;
  }
  for (const entry of links) {
    console.log(`Gateway ${entry.pid}, started ${new Date(entry.startedAt).toLocaleString()} (proxy ${entry.proxy}):`);
    console.log(`  ${entry.link}`);
  }
  console.log("\nOpen a link in a browser on this machine. It carries the page's key, so don't share it.");
}

async function doDoctor(args: string[]): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  console.log("Config");
  // Missing on a first run, which is fine: signing in creates it.
  const haveConfig = existsSync(CONFIG_DIR);
  console.log(`  ${haveConfig ? "ok  " : "..  "}  config directory — ${CONFIG_DIR}${haveConfig ? "" : " (not created yet; signing in creates it)"}`);
  check("token cache", existsSync(CACHE_FILE), existsSync(CACHE_FILE) ? CACHE_FILE : "not signed in: run `opencode-m365 start` or `opencode-m365 login`");
  if (existsSync(SECRETS_FILE)) {
    // Left over from upstream's automated sign-in. This fork never reads it, but it
    // still holds a password and a TOTP seed in plain text.
    console.log(`  WARN  ${SECRETS_FILE} exists — it holds a password and TOTP seed and is never read by this fork. Delete it.`);
  }

  console.log("\nAuthentication");
  const tokens = createTokenClient();
  let signedIn = false;
  try {
    const token = await tokens.getToken();
    signedIn = true;
    check("chat token", true, `${token.length} chars`);
  } catch (error) {
    check("chat token", false, (error as Error).message);
  }

  console.log("\nPrivacy");
  const settings = createSettingsStore();
  const described = settings.describe();
  console.log(`  ..    work data (Work IQ) — ${describeWorkIq(described.workIq.value)}${sourceNote(described.workIq)}`);
  console.log(`  ..    Bing web search — ${described.webSearch.value ? "on" : "off"}${sourceNote(described.webSearch)}`);
  console.log(`  ..    allowed addresses — ${ALLOWED_HOSTS.auth} (sign-in), ${ALLOWED_HOSTS.chat} (Copilot)`);

  console.log("\nProxy");
  try {
    const proxy = await startServer({ getToken: () => tokens.getToken(), settings: () => settings.current(), port: 0 });
    const response = await fetch(`${proxy.url}/health`);
    check("starts and serves /health", response.ok, proxy.url);
    const refused = await fetch(`${proxy.url}/v1/models`);
    check("refuses a request without the secret", refused.status === 401);
    const models: any = await (await fetch(`${proxy.url}/v1/models`, { headers: { Authorization: `Bearer ${proxy.apiKey}` } })).json();
    check("advertises models", models.data?.length > 0, `${models.data?.length ?? 0} models`);
    check("local titler present", models.data?.some((m: any) => m.id === LOCAL_TITLE_MODEL));
    await proxy.close();
  } catch (error) {
    check("starts", false, (error as Error).message);
  }

  if (args.includes("--live")) {
    console.log("\nLive turns (one conversation, one short message per tone)");
    if (!signedIn) {
      console.log("  skip  needs a signed-in account");
    } else {
      const session = new CopilotSession({ getToken: () => tokens.getToken() });
      for (const { tone, ok, detail } of await checkTones(session, distinctTones(MODELS))) {
        check(tone, ok, detail);
      }
    }
  }

  console.log("\nOpenCode");
  const status = openCodeStatus();
  if (status.problem) check("config readable", false, `${status.configPath} is ${status.problem}`);
  check("gateway connected", status.connected, status.connected ? status.configPath : "see the Set up page, or run `opencode-m365 setup`");

  if (args.includes("--browser")) {
    const seconds = secondsFrom(args) ?? 60;
    console.log(`\nSign-in browser, on an empty page for ${seconds} s (what it tries to reach is refused, not sent)`);
    try {
      const { browserTraffic } = await import("./login.js");
      const traffic = await browserTraffic({ browser: settings.current().signInBrowser, seconds });
      if (traffic.hosts.size === 0) {
        check(traffic.browser, true, "tried to contact nothing by itself");
      } else {
        console.log(`  ..    ${traffic.browser} tried to contact:`);
        for (const [host, count] of [...traffic.hosts].sort()) {
          const how = traffic.direct.has(host) ? "went around this check: a policy gives the browser its own proxy" : "refused";
          console.log(`          ${host} (${count}×, ${how})`);
        }
      }
    } catch (error) {
      check("opens the sign-in browser", false, (error as Error).message.split("\n")[0]);
    }
  }

  process.exitCode = failures > 0 ? 1 : 0;
}

function sourceNote(state: SettingState): string {
  return state.lockedBy ? ` (set by ${state.lockedBy})` : state.source === "saved" ? " (saved setting)" : "";
}

function secondsFrom(args: string[]): number | undefined {
  const index = args.indexOf("--seconds");
  if (index < 0) return undefined;
  const seconds = Number(args[index + 1]);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error(`--seconds needs a number from 1 to 600, not ${args[index + 1] ?? "nothing"}`);
  return seconds;
}

function portFrom(args: string[]): number | undefined {
  const index = args.indexOf("--port");
  if (index < 0) return undefined;
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port needs a number from 0 to 65535, not ${args[index + 1] ?? "nothing"}`);
  return port;
}

function stopOnSignal(handles: ({ close(): Promise<void> } | undefined)[]): void {
  const stop = () => {
    void Promise.all(handles.map((handle) => handle?.close())).then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
