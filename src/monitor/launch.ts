/**
 * Bring the gateway's page up next to a running gateway, leave its link where
 * `opencode-m365 open` can find it, and open it in the browser when asked. Shared by
 * the plugin and the standalone app.
 */

import { openInBrowser } from "../open-url.js";
import type { AppController } from "./app.js";
import type { GatewayFacts } from "./events.js";
import { publishMonitorLink } from "./links.js";
import type { Monitor } from "./monitor.js";
import { startMonitorServer } from "./server.js";

export interface LaunchedPage {
  /** The page's address with its key: what to open. */
  link: string;
  /** Whether the browser was asked to open it. */
  opened: boolean;
  close(): Promise<void>;
}

export interface LaunchOptions {
  monitor: Monitor;
  facts: GatewayFacts;
  app?: AppController;
  /** Ask the system to open the page in the default browser. */
  open?: boolean;
}

export async function launchPage(options: LaunchOptions): Promise<LaunchedPage> {
  const server = await startMonitorServer({
    monitor: options.monitor,
    facts: options.facts,
    ...(options.app ? { app: options.app } : {}),
  });
  let unpublish: () => void = () => {};
  try {
    unpublish = publishMonitorLink(
      { pid: options.facts.pid, link: server.link, startedAt: options.facts.startedAt, proxy: options.facts.proxy },
      server.port,
    );
  } catch {
    // The page still works; only `opencode-m365 open` cannot find it. The app prints
    // the link itself.
  }
  const opened = options.open ? openInBrowser(server.link) : false;
  return {
    link: server.link,
    opened,
    close: async () => {
      unpublish();
      await server.close();
    },
  };
}
