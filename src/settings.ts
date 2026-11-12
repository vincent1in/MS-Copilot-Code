/**
 * The gateway's settings: one place for every option a user can change, which the
 * app's Settings page edits and every gateway on this computer reads.
 *
 * Where a value comes from, strongest first:
 *
 * 1. An environment variable (`M365_WORK_IQ`, `M365_WEB_SEARCH=1`, `M365_MONITOR=1`).
 * 2. The plugin's options in OpenCode's config, when this gateway runs inside OpenCode.
 * 3. What was saved from the Settings page, in `settings.json` (owner-only).
 * 4. The default.
 *
 * A value pinned by 1 or 2 is shown on the page as locked, with where it is set, so the
 * page never pretends to change something it cannot. Saved values are re-read when the
 * file changes, so a change made in the app reaches a gateway running inside OpenCode
 * from its next message, without a restart.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./log.js";
import { CONFIG_DIR } from "./paths.js";
import { writePrivateFile } from "./private-fs.js";
import { WORK_IQ_POLICIES, type WorkIqPolicy } from "./workiq.js";

const log = createLogger("settings");

export const SETTINGS_FILE = process.env.M365_SETTINGS_FILE || join(CONFIG_DIR, "settings.json");

/** What this page does when OpenCode starts. */
export type PageWithOpenCode = "off" | "on" | "open";
/** Which installed browser signs you in. `auto` tries Edge, then Chrome. */
export type SignInBrowser = "auto" | "msedge" | "chrome";

export interface GatewaySettings {
  /** A reply Copilot drew from your work data: hold it, flag it, or allow it. */
  workIq: WorkIqPolicy;
  /** Offer Copilot Bing web search on coding turns. */
  webSearch: boolean;
  /** Trim OpenCode's tools to the few Copilot keeps engaging with. */
  lean: boolean;
  /** Replace OpenCode's long system prompt with a short one. */
  leanSystemPrompt: boolean;
  /** Write session titles locally instead of asking Copilot (saves a conversation each). */
  localTitles: boolean;
  /** Make the default m365 model OpenCode's model when none is picked. */
  setDefaultModel: boolean;
  /** Run this page when OpenCode starts, and whether to open it. */
  pageWithOpenCode: PageWithOpenCode;
  signInBrowser: SignInBrowser;
}

export type SettingKey = keyof GatewaySettings;

export const DEFAULT_SETTINGS: Readonly<GatewaySettings> = {
  workIq: "hold",
  webSearch: false,
  lean: true,
  leanSystemPrompt: false,
  localTitles: true,
  setDefaultModel: true,
  pageWithOpenCode: "off",
  signInBrowser: "auto",
};

export type SettingSource = "default" | "saved" | "opencode" | "environment";

export interface SettingState<K extends SettingKey = SettingKey> {
  value: GatewaySettings[K];
  source: SettingSource;
  /** Set where the page cannot change it: the variable or file that pins it. */
  lockedBy?: string;
}

export type DescribedSettings = { [K in SettingKey]: SettingState<K> };

export class SettingLockedError extends Error {
  constructor(key: SettingKey, by: string) {
    super(`"${key}" is set by ${by}, so it cannot be changed here. Remove it there first.`);
    this.name = "SettingLockedError";
  }
}

export class SettingValueError extends Error {
  constructor(key: string, value: unknown) {
    super(`${JSON.stringify(value)} is not a valid value for "${key}".`);
    this.name = "SettingValueError";
  }
}

type Parse<T> = (value: unknown) => T | undefined;

const bool: Parse<boolean> = (value) => (typeof value === "boolean" ? value : undefined);
const oneOf =
  <T extends string>(choices: readonly T[]): Parse<T> =>
  (value) =>
    typeof value === "string" && (choices as readonly string[]).includes(value) ? (value as T) : undefined;

interface Spec<K extends SettingKey> {
  parse: Parse<GatewaySettings[K]>;
  /** The environment variable that pins it, and how its text reads. */
  env?: { name: string; read: (raw: string) => GatewaySettings[K] | undefined };
  /** The plugin option in OpenCode's config that pins it, and how its value reads. */
  plugin?: { name: string; read: (raw: unknown) => GatewaySettings[K] | undefined };
}

const SPECS: { [K in SettingKey]: Spec<K> } = {
  workIq: {
    parse: oneOf(WORK_IQ_POLICIES),
    env: { name: "M365_WORK_IQ", read: (raw) => oneOf(WORK_IQ_POLICIES)(raw.trim().toLowerCase()) },
    plugin: { name: "workIq", read: oneOf(WORK_IQ_POLICIES) },
  },
  webSearch: {
    parse: bool,
    env: { name: "M365_WEB_SEARCH", read: (raw) => (raw === "1" ? true : undefined) },
    plugin: { name: "webSearch", read: bool },
  },
  lean: { parse: bool, plugin: { name: "lean", read: bool } },
  leanSystemPrompt: { parse: bool, plugin: { name: "leanSystemPrompt", read: bool } },
  localTitles: { parse: bool, plugin: { name: "setSmallModel", read: bool } },
  setDefaultModel: { parse: bool, plugin: { name: "setDefaultModel", read: bool } },
  pageWithOpenCode: {
    parse: oneOf(["off", "on", "open"] as const),
    env: { name: "M365_MONITOR", read: (raw) => (raw === "1" ? "on" : undefined) },
    plugin: { name: "monitor", read: (raw) => (raw === true ? "on" : raw === false ? "off" : undefined) },
  },
  signInBrowser: { parse: oneOf(["auto", "msedge", "chrome"] as const) },
};

export const SETTING_KEYS = Object.keys(SPECS) as SettingKey[];

export interface SettingsStore {
  /** The effective settings now. Picks up a saved file that changed on disk. */
  current(): GatewaySettings;
  /** Every setting with where its value comes from. */
  describe(): DescribedSettings;
  /** Save one setting. Throws {@link SettingLockedError} or {@link SettingValueError}. */
  set(key: string, value: unknown): GatewaySettings;
  /** Called after any change, saved here or picked up from disk. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  readonly file: string;
}

export interface SettingsStoreOptions {
  file?: string;
  /** The plugin's raw options from OpenCode's config, when running inside OpenCode. */
  pluginOptions?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
}

export function createSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  const file = options.file ?? SETTINGS_FILE;
  const env = options.env ?? process.env;
  const plugin = options.pluginOptions ?? {};
  const listeners = new Set<() => void>();

  let saved: Partial<GatewaySettings> = {};
  let seen = "";

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a listener cannot stop a setting from applying */
      }
    }
  };

  /** Re-read the file if it changed since we last looked. Returns whether it did. */
  const refresh = (): boolean => {
    let stamp: string;
    try {
      const stat = statSync(file);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = "missing";
    }
    if (stamp === seen) return false;
    seen = stamp;
    saved = stamp === "missing" ? {} : readSaved(file);
    return true;
  };

  const describe = (): DescribedSettings => {
    const out = {} as Record<SettingKey, SettingState>;
    for (const key of SETTING_KEYS) out[key] = resolve(key, SPECS[key] as Spec<typeof key>, env, plugin, saved);
    return out as DescribedSettings;
  };

  const current = (): GatewaySettings => {
    if (refresh()) notify();
    const described = describe();
    const out = {} as Record<SettingKey, unknown>;
    for (const key of SETTING_KEYS) out[key] = described[key].value;
    return out as unknown as GatewaySettings;
  };

  refresh();

  return {
    file,
    current,
    describe: () => {
      refresh();
      return describe();
    },
    set(key, value) {
      if (!(SETTING_KEYS as string[]).includes(key)) throw new SettingValueError(key, value);
      const settingKey = key as SettingKey;
      const parsed = (SPECS[settingKey].parse as Parse<unknown>)(value);
      if (parsed === undefined) throw new SettingValueError(key, value);
      refresh();
      const state = resolve(settingKey, SPECS[settingKey] as Spec<typeof settingKey>, env, plugin, saved);
      if (state.lockedBy) throw new SettingLockedError(settingKey, state.lockedBy);
      saved = { ...saved, [settingKey]: parsed };
      writePrivateFile(file, `${JSON.stringify(saved, null, 2)}\n`);
      seen = "";
      refresh();
      notify();
      return current();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function resolve<K extends SettingKey>(
  key: K,
  spec: Spec<K>,
  env: Record<string, string | undefined>,
  plugin: Record<string, unknown>,
  saved: Partial<GatewaySettings>,
): SettingState<K> {
  if (spec.env) {
    const raw = env[spec.env.name];
    const value = raw === undefined || raw === "" ? undefined : spec.env.read(raw);
    if (value !== undefined) return { value, source: "environment", lockedBy: `the ${spec.env.name} environment variable` };
  }
  if (spec.plugin && Object.hasOwn(plugin, spec.plugin.name)) {
    const value = spec.plugin.read(plugin[spec.plugin.name]);
    if (value !== undefined) return { value, source: "opencode", lockedBy: `the "${spec.plugin.name}" option in OpenCode's config` };
  }
  const stored = saved[key];
  if (stored !== undefined) return { value: stored as GatewaySettings[K], source: "saved" };
  return { value: DEFAULT_SETTINGS[key], source: "default" };
}

function readSaved(file: string): Partial<GatewaySettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    log.warn("settings file is not valid JSON; using defaults", String(error));
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<GatewaySettings> = {};
  for (const key of SETTING_KEYS) {
    const value = (SPECS[key].parse as Parse<unknown>)((raw as Record<string, unknown>)[key]);
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
