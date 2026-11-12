/**
 * Reading and changing OpenCode's own config file, for `opencode-m365 setup` and the
 * app's "Connect OpenCode" step.
 *
 * It is the user's file, not ours: a change keeps everything else in it, saves the
 * previous version next to it as `opencode.json.bak`, and is only ever made when the
 * user asks (the command, or the button).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeOpencodeConfig, type PluginPathInfo } from "./config.js";
import { GATEWAY_DIR } from "./paths.js";

export const OPENCODE_CONFIG = process.env.M365_OPENCODE_CONFIG || join(homedir(), ".config", "opencode", "opencode.json");

/**
 * OpenCode's own outside traffic that its config can switch off, checked against the
 * schema of OpenCode 2.2.6 (`@opencode/schema`): update checks, session sharing, and
 * its built-in web search tool. The model catalogue download has no config key.
 */
export const OPENCODE_QUIET: Readonly<Record<"update" | "share" | "websearch", unknown>> = {
  update: "disable",
  share: "disabled",
  websearch: false,
};

/** This checkout: the directory OpenCode loads, and its built entry. */
export function thisCheckout(): { pluginDir: string; pluginRef: string } {
  return { pluginDir: GATEWAY_DIR, pluginRef: resolve(GATEWAY_DIR, "dist", "plugin.mjs") };
}

export interface OpenCodeStatus {
  configPath: string;
  /** The config file exists and is valid JSON. */
  readable: boolean;
  /** Why it could not be read, when it exists but is not valid JSON. */
  problem?: string;
  /** OpenCode loads this checkout as a plugin. */
  connected: boolean;
  /** The options on our plugin entry, if any — they pin settings (see settings.ts). */
  pluginOptions?: Record<string, unknown>;
  /** Whether each of OpenCode's own outside-traffic switches is already off. */
  quiet: Record<keyof typeof OPENCODE_QUIET, boolean>;
}

export function openCodeStatus(pluginDir = thisCheckout().pluginDir, configPath = OPENCODE_CONFIG): OpenCodeStatus {
  const quietNone = { update: false, share: false, websearch: false };
  if (!existsSync(configPath)) return { configPath, readable: false, connected: false, quiet: quietNone };
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    return { configPath, readable: false, problem: `not valid JSON: ${(error as Error).message}`, connected: false, quiet: quietNone };
  }
  const entry = (Array.isArray(config.plugins) ? config.plugins : []).find((candidate: unknown) => {
    const spec = typeof candidate === "string" ? candidate : (candidate as { package?: unknown })?.package;
    return typeof spec === "string" && resolve(spec) === resolve(pluginDir);
  });
  const options = entry && typeof entry === "object" && entry.options && typeof entry.options === "object" ? entry.options : undefined;
  return {
    configPath,
    readable: true,
    connected: entry !== undefined,
    ...(options ? { pluginOptions: options as Record<string, unknown> } : {}),
    quiet: {
      update: config.update === OPENCODE_QUIET.update,
      share: config.share === OPENCODE_QUIET.share,
      websearch: config.websearch === OPENCODE_QUIET.websearch,
    },
  };
}

export interface ConnectResult {
  configPath: string;
  /** Where the previous version was saved, when there was one. */
  backupPath?: string;
  /** Our old opencode 1 `plugin` entry was taken out. */
  removedLegacyEntry: boolean;
}

/**
 * Add this checkout to OpenCode's plugins, and optionally switch off OpenCode's own
 * outside traffic. Throws if the existing file is not valid JSON: it is not ours to
 * overwrite.
 */
export function connectOpenCode(
  options: { quiet?: boolean; pluginDir?: string; pluginRef?: string; configPath?: string } = {},
): ConnectResult {
  const checkout = thisCheckout();
  const pluginDir = options.pluginDir ?? checkout.pluginDir;
  const pluginRef = options.pluginRef ?? checkout.pluginRef;
  const configPath = options.configPath ?? OPENCODE_CONFIG;

  let existing: Record<string, any> = {};
  const hadConfig = existsSync(configPath);
  if (hadConfig) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(`${configPath} is not valid JSON, so it was left alone. Fix or move it first. (${(error as Error).message})`);
    }
  }

  const merged = mergeOpencodeConfig(existing, { pluginRef, pluginDir, inspect: inspectPluginPath });
  if (options.quiet) Object.assign(merged, OPENCODE_QUIET);

  mkdirSync(dirname(configPath), { recursive: true });
  const backupPath = `${configPath}.bak`;
  if (hadConfig) copyFileSync(configPath, backupPath);
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  return {
    configPath,
    ...(hadConfig ? { backupPath } : {}),
    removedLegacyEntry: existing.plugin !== undefined && JSON.stringify(existing.plugin) !== JSON.stringify(merged.plugin),
  };
}

/** Which package owns a local plugin path: its own dir or the one above (`dist/`). */
export function inspectPluginPath(path: string): PluginPathInfo {
  if (!existsSync(path)) return { exists: false };
  const start = path.endsWith(".mjs") || path.endsWith(".js") ? dirname(path) : path;
  for (const dir of [start, dirname(start)]) {
    try {
      const name = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.name;
      if (typeof name === "string") return { exists: true, packageName: name };
    } catch {
      /* no package.json here; try one level up */
    }
  }
  return { exists: true };
}
