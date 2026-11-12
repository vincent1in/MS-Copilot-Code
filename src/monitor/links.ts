/**
 * How `opencode-m365 monitor` finds the monitor of a gateway running inside opencode.
 *
 * The plugin's gateway has no terminal to print its link to, so while it runs it
 * leaves one small file per gateway in an owner-only directory: the link (which
 * carries the page's per-launch secret), the process id, and when it started. The file
 * is removed when the gateway stops; one left behind by a crash is removed the next
 * time anyone lists links, once its process is gone.
 *
 * The link file holds a key to the page, not anything the page shows. The monitor's
 * contents are never written anywhere.
 */

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../paths.js";
import { ensurePrivateDir, writePrivateFile } from "../private-fs.js";

export const MONITOR_LINK_DIR = join(CONFIG_DIR, "monitor");

export interface MonitorLink {
  pid: number;
  /** The page URL with its secret in the fragment, which browsers never send. */
  link: string;
  startedAt: string;
  /** Where opencode reaches this gateway's proxy (no secret). */
  proxy: string;
}

/** Leave `entry` for the CLI to find. Returns the function that removes it again. */
export function publishMonitorLink(entry: MonitorLink, port: number, dir = MONITOR_LINK_DIR): () => void {
  ensurePrivateDir(dir);
  const file = join(dir, `${entry.pid}-${port}.json`);
  writePrivateFile(file, `${JSON.stringify(entry)}\n`);
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    process.off("exit", remove);
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", remove);
  return remove;
}

/** Monitors of gateways that are still running, newest first. Clears out stale files. */
export function listMonitorLinks(dir = MONITOR_LINK_DIR, isAlive: (pid: number) => boolean = processIsAlive): MonitorLink[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const links: MonitorLink[] = [];
  for (const name of names) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    const file = join(dir, name);
    let entry: MonitorLink | undefined;
    try {
      entry = parseLink(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      entry = undefined;
    }
    if (!entry || !isAlive(entry.pid)) {
      try {
        unlinkSync(file);
      } catch {
        /* someone else tidied it */
      }
      continue;
    }
    links.push(entry);
  }
  return links.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function parseLink(value: unknown): MonitorLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { pid, link, startedAt, proxy } = value as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof link !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/#k=[A-Za-z0-9_-]+$/.test(link)) return undefined;
  if (typeof startedAt !== "string" || typeof proxy !== "string") return undefined;
  return { pid, link, startedAt, proxy };
}

/**
 * Signal 0 checks for a process without touching it. EPERM means the pid now belongs
 * to another user — our gateway ran as us, so that is a reused pid, and the link is
 * stale like any other.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
