/**
 * What the plugin stands on: the OpenAI-compatible proxy, started in-process (or an
 * external one, when `baseUrl` is set), and the URL and secret it listens with. The
 * opencode-facing half — provider registration, the title hook — is `plugin-v2.ts`.
 *
 * Sign-in is deliberately not here: the plugin only refreshes silently, and tells the
 * user to run `opencode-m365 login` (or use the app) if it cannot. Driving a sign-in
 * browser underneath a TUI is not something a plugin should do.
 */

import { createTokenClient } from "./auth.js";
import { resolveOptions, type PluginOptions } from "./config.js";
import { createLogger } from "./log.js";
import { createAppController } from "./monitor/app.js";
import { launchPage, type LaunchedPage } from "./monitor/launch.js";
import { createMonitor } from "./monitor/monitor.js";
import { DEFAULT_MODEL } from "./models.js";
import { startServer } from "./server.js";
import { createSettingsStore, type SettingsStore } from "./settings.js";
import { gatewayCommand } from "./paths.js";

const log = createLogger("plugin");

export interface M365Runtime {
  /** Where the OpenAI-compatible surface is, ready to hand to a provider entry. */
  baseUrl: string;
  /** The bearer secret that surface demands, ready to hand over as the `apiKey`. */
  apiKey: string;
  options: PluginOptions;
  /** The settings in force (see settings.ts); the plugin re-reads them as it goes. */
  settings: SettingsStore;
  /** Stops the proxy and its page, if this runtime is the one that started them. */
  close(): Promise<void>;
}

/**
 * Resolve options and bring the proxy up — and the gateway's page, when the
 * `pageWithOpenCode` setting asks for it.
 *
 * With `baseUrl` set the caller already has a proxy running — `opencode-m365 start`,
 * `serve`, or a test — and we attach to it rather than binding a second port. `close()`
 * is then a no-op, because a runtime must not shut down a server it did not start.
 */
export async function startRuntime(rawOptions?: Record<string, unknown>, deps: { settingsFile?: string } = {}): Promise<M365Runtime> {
  const options = resolveOptions(rawOptions);
  if (rawOptions?.studioAgent === true) log.warn("ignoring studioAgent: Copilot Studio support is removed from this fork");
  if (typeof rawOptions?.baseUrl === "string" && rawOptions.baseUrl !== "" && !options.baseUrl) {
    log.warn("ignoring baseUrl: only a proxy on this machine (loopback http/https) is accepted; using the in-process proxy");
  }
  const settings = createSettingsStore({ pluginOptions: rawOptions ?? {}, ...(deps.settingsFile ? { file: deps.settingsFile } : {}) });
  const sharedKey = process.env.M365_PROXY_KEY || undefined;

  if (options.baseUrl) {
    const apiKey = options.apiKey ?? sharedKey;
    if (!apiKey) {
      // Not a throw: a plugin that throws during load takes opencode's whole config
      // with it. The proxy will answer 401 with the same advice.
      log.warn(
        `baseUrl is set but no proxy secret is: pass the key ${gatewayCommand("serve")} printed as the \`apiKey\` plugin option, or set M365_PROXY_KEY`,
      );
    }
    return { baseUrl: options.baseUrl, apiKey: apiKey ?? "missing-proxy-secret", options, settings, close: async () => {} };
  }

  const tokens = createTokenClient();
  const initial = settings.current();
  // The page is opt-in (the pageWithOpenCode setting) and memory-only.
  const monitor = initial.pageWithOpenCode !== "off" ? createMonitor() : undefined;
  const proxy = await startServer({
    getToken: () => tokens.getToken(),
    settings: () => settings.current(),
    ...(monitor ? { monitor } : {}),
    // Normally absent, so the proxy mints a fresh secret for this launch.
    ...(sharedKey ? { apiKey: sharedKey } : {}),
  });

  log.info(`M365 Copilot proxy listening on ${proxy.url}`);

  let page: LaunchedPage | undefined;
  if (monitor) {
    try {
      const facts = { context: "opencode" as const, proxy: proxy.url, pid: process.pid, defaultModel: DEFAULT_MODEL, startedAt: new Date().toISOString() };
      const app = createAppController({ context: "opencode", facts, tokens, settings, proxy: { url: proxy.url, apiKey: proxy.apiKey } });
      page = await launchPage({ monitor, facts, app, open: initial.pageWithOpenCode === "open" });
      // The link carries the page's key, so it is not logged: `opencode-m365 open`
      // reads it from an owner-only file instead.
      log.info(`the gateway page is on; run ${gatewayCommand("open")} to see it`);
    } catch (error) {
      // A page that cannot start must not take the gateway down with it.
      log.warn("the gateway page could not start; continuing without it", String(error));
    }
  }

  return {
    baseUrl: `${proxy.url}/v1`,
    apiKey: proxy.apiKey,
    options,
    settings,
    close: async () => {
      await page?.close();
      await proxy.close();
    },
  };
}
