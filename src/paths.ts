import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This gateway's folder, the one OpenCode loads as a plugin. Modules are bundled into
 * `dist/*.mjs`, or run from `src/` in tests: either way it is one directory up.
 */
export const GATEWAY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One of the gateway's commands, written so it runs from any directory:
 * `node "<folder>/dist/cli.mjs" <args>`. Nothing puts an `opencode-m365` command on
 * the PATH, so messages give this form.
 */
export function gatewayCommand(args: string, dir: string = GATEWAY_DIR): string {
  return `node "${join(dir, "dist", "cli.mjs")}" ${args}`;
}

/**
 * Where we keep auth state.
 *
 * Deliberately NOT `~/.config/opencode-m365/` — that belongs to the
 * m365-copilot-proxy project, and sharing it would mean two independent tools
 * writing the same MSAL cache and agent-id file.
 */
export const CONFIG_DIR = process.env.M365_CONFIG_DIR || join(homedir(), ".config", "opencode-copilot");

export const CACHE_FILE = process.env.M365_CACHE_FILE || join(CONFIG_DIR, "msal-cache.json");
/**
 * Upstream's stored-credentials file (password + TOTP seed). Never read by this fork;
 * kept only so `doctor` can warn that a leftover copy should be deleted.
 */
export const SECRETS_FILE = process.env.M365_SECRETS_FILE || join(CONFIG_DIR, "secrets.json");
export const LOG_FILE = join(CONFIG_DIR, "debug.log");
