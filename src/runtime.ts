/**
 * What the plugin stands on: the OpenAI-compatible proxy, started in-process (or an
 * external one, when `baseUrl` is set), and the URL and secret it listens with. The
 * opencode-facing half — provider registration, the title hook — is `plugin-v2.ts`.
 *
 * Auth is deliberately not here: the plugin only refreshes silently, and tells the
 * user to run `opencode-m365 login` if it cannot. Launching a browser underneath a
 * TUI is not something a plugin should do.
 */

import { getOrCreateAgent } from "./agent.js";
import { createTokenClient } from "./auth.js";
import { resolveOptions, monitorEnabled, studioAgentEnabled, webSearchEnabled, type PluginOptions } from "./config.js";
import { createLogger } from "./log.js";
import { launchMonitor, type LaunchedMonitor } from "./monitor/launch.js";
import { createMonitor } from "./monitor/monitor.js";
import { DEFAULT_MODEL } from "./models.js";
import { startServer } from "./server.js";
import { workIqPolicy } from "./workiq.js";

const log = createLogger("plugin");

/**
 * The system prompt used for M365 models.
 *
 * opencode's own prompt is long and carefully worded for frontier models. Measured
 * against M365, a shorter and blunter prompt produced markedly better tool
 * compliance — the same model confabulates ("I can't access the files, paste them")
 * under a longer, more polished assistant prompt.
 *
 * This is applied in the **proxy**, not through opencode's own hook. Verified
 * against opencode 1.18.18: `experimental.chat.system.transform` fires and happily
 * accepts a replacement `system` array, but the request that reaches the provider
 * still carries the original prompt; setting `agent.<name>.prompt` from the `config`
 * hook is ignored the same way. Since our provider only ever serves our own models,
 * doing it proxy-side is also correctly scoped — no other provider is affected.
 *
 * opencode 2 offers `session.hook("context")` as a working replacement for that dead
 * v1 hook. It has not been measured against a live tenant, and the proxy is the only
 * layer that is true for every harness, so the logic stays here until it has been.
 */
const LEAN_SYSTEM_PROMPT = [
  "You are a coding agent working in the user's real workspace on this machine.",
  "The files and commands are real, and anything you run actually runs.",
  "",
  "Work one step at a time: take an action, read the result, then decide the next step.",
  "Inspect before you change something, and check your change afterwards.",
  "Report what you actually did, not what you intended to do.",
].join("\n");

export interface M365Runtime {
  /** Where the OpenAI-compatible surface is, ready to hand to a provider entry. */
  baseUrl: string;
  /** The bearer secret that surface demands, ready to hand over as the `apiKey`. */
  apiKey: string;
  options: PluginOptions;
  /** Stops the proxy, if this runtime is the one that started it. */
  close(): Promise<void>;
}

/**
 * Resolve options and bring the proxy up.
 *
 * With `baseUrl` set the caller already has a proxy running — `opencode-m365 serve`,
 * or a test — and we attach to it rather than binding a second port. `close()` is
 * then a no-op, because a runtime must not shut down a server it did not start.
 */
export async function startRuntime(rawOptions?: Record<string, unknown>): Promise<M365Runtime> {
  const options = resolveOptions(rawOptions as Partial<PluginOptions> | undefined);
  if (typeof rawOptions?.baseUrl === "string" && rawOptions.baseUrl !== "" && !options.baseUrl) {
    log.warn("ignoring baseUrl: only a proxy on this machine (loopback http/https) is accepted; using the in-process proxy");
  }
  const sharedKey = process.env.M365_PROXY_KEY || undefined;

  if (options.baseUrl) {
    const apiKey = options.apiKey ?? sharedKey;
    if (!apiKey) {
      // Not a throw: a plugin that throws during load takes opencode's whole config
      // with it. The proxy will answer 401 with the same advice.
      log.warn(
        "baseUrl is set but no proxy secret is: pass the key `opencode-m365 serve` printed as the `apiKey` plugin option, or set M365_PROXY_KEY",
      );
    }
    return { baseUrl: options.baseUrl, apiKey: apiKey ?? "missing-proxy-secret", options, close: async () => {} };
  }

  const tokens = createTokenClient();
  // The Copilot Studio agent is opt-in (see PluginOptions.studioAgent). Without
  // `resolveAgent` the proxy never asks for Power Platform / BAP tokens and never
  // creates anything in the tenant; tool turns go out agent-less.
  const useStudioAgent = studioAgentEnabled(options);
  log.info(`Copilot Studio agent: ${useStudioAgent ? "enabled (provisioned lazily on the first tool turn)" : "disabled"}`);
  // The monitor is opt-in (see PluginOptions.monitor) and memory-only.
  const monitor = monitorEnabled(options) ? createMonitor() : undefined;
  const workIq = workIqPolicy(options);
  const webSearch = webSearchEnabled(options);
  const proxy = await startServer({
    getToken: () => tokens.getToken(),
    ...(useStudioAgent
      ? { resolveAgent: () => getOrCreateAgent({ getTokenForScope: (scopes) => tokens.getTokenForScope(scopes) }) }
      : {}),
    lean: options.lean,
    webSearch,
    workIq,
    ...(monitor ? { monitor } : {}),
    // Normally absent, so the proxy mints a fresh secret for this launch.
    ...(sharedKey ? { apiKey: sharedKey } : {}),
    ...(options.leanSystemPrompt ? { leanSystemPrompt: LEAN_SYSTEM_PROMPT } : {}),
  });

  log.info(`M365 Copilot proxy listening on ${proxy.url}`);
  log.info(`replies drawn from work data (Work IQ): ${workIq}`);

  let launched: LaunchedMonitor | undefined;
  if (monitor) {
    try {
      launched = await launchMonitor(monitor, {
        proxy: proxy.url,
        defaultModel: DEFAULT_MODEL,
        webSearch,
        studioAgent: useStudioAgent,
        lean: options.lean,
        workIq,
      });
      // The link carries the page's secret, so it is not logged: the CLI reads it from
      // an owner-only file instead.
      log.info("gateway monitor is on; run `opencode-m365 monitor` for its link");
    } catch (error) {
      // A monitor that cannot start must not take the gateway down with it.
      log.warn("gateway monitor could not start; continuing without it", String(error));
    }
  }

  return {
    baseUrl: `${proxy.url}/v1`,
    apiKey: proxy.apiKey,
    options,
    close: async () => {
      await launched?.close();
      await proxy.close();
    },
  };
}
