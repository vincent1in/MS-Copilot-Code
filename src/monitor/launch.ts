/**
 * Bring the monitor page up next to a running gateway, and leave its link where
 * `opencode-m365 monitor` can find it. Shared by the plugin and `opencode-m365 serve`.
 */

import type { GatewayFacts } from "./events.js";
import { publishMonitorLink } from "./links.js";
import type { Monitor } from "./monitor.js";
import { startMonitorServer } from "./server.js";

export interface LaunchedMonitor {
  /** The page's address with its secret: what to open. */
  link: string;
  close(): Promise<void>;
}

export async function launchMonitor(monitor: Monitor, facts: Omit<GatewayFacts, "pid" | "startedAt">): Promise<LaunchedMonitor> {
  const startedAt = new Date().toISOString();
  const server = await startMonitorServer({ monitor, facts: { ...facts, pid: process.pid, startedAt } });
  let unpublish: () => void = () => {};
  try {
    unpublish = publishMonitorLink({ pid: process.pid, link: server.link, startedAt, proxy: facts.proxy }, server.port);
  } catch {
    // The page still works; only `opencode-m365 monitor` cannot find it. `serve`
    // prints the link itself.
  }
  return {
    link: server.link,
    close: async () => {
      unpublish();
      await server.close();
    },
  };
}
