/**
 * The page's backend: what the Set up and Settings tabs show and do.
 *
 * - Set up: who is signed in (read from the token cache, no network), signing in (the
 *   standalone app only: a plugin running under OpenCode must not drive a browser),
 *   sending a test message through this gateway, and whether OpenCode is connected.
 *   Connecting OpenCode is left to the user, with instructions: the page reads
 *   OpenCode's config to show the status, and never writes it.
 * - Settings: every setting with where its value comes from, and saving one.
 *
 * Every action is something the user clicked; nothing here runs on its own.
 */

import { randomUUID } from "node:crypto";
import type { TokenClient } from "../auth.js";
import { ALLOWED_HOSTS } from "../egress.js";
import { DEFAULT_MODEL, MODELS } from "../models.js";
import { OPENCODE_QUIET, openCodeStatus, thisCheckout, type OpenCodeStatus } from "../opencode-config.js";
import { SESSION_ID_HEADER } from "../server.js";
import type { DescribedSettings, SettingsStore, SignInBrowser } from "../settings.js";
import type { GatewayFacts } from "./events.js";

/** The test message. Neutral on purpose: no code, nothing about you, no instructions to act. */
export const TEST_PROMPT =
  "This is a connection test from the opencode-m365 gateway on my computer. Please reply with one short sentence so I know it arrived.";

/** Test sessions are named so the Traffic tab can label them. */
export const TEST_SESSION_PREFIX = "connection-test-";

export interface TestResult {
  ok: boolean;
  model: string;
  at: string;
  ms: number;
  reply?: string;
  error?: string;
  code?: string;
  /** The opencode-style session id the test ran under, to find it in Traffic. */
  session: string;
}

export interface AppState {
  context: "app" | "opencode";
  facts: GatewayFacts;
  /** The signed-in account, from the token cache. Null when nobody is signed in. */
  account: string | null;
  signIn: {
    /** This gateway can open a sign-in window (the standalone app). */
    available: boolean;
    running: boolean;
    error?: string;
    /** What to run in a terminal instead, when it cannot. */
    command: string;
  };
  test: {
    running: boolean;
    last?: TestResult;
    /** Exactly what the test sends, shown before you send it. */
    prompt: string;
  };
  opencode: OpenCodeStatus & {
    /** This gateway's folder, which OpenCode's config names as a plugin. */
    pluginDir: string;
    /** The settings that switch off OpenCode's own outside traffic, to copy. */
    quietSettings: Record<string, unknown>;
  };
  settings: DescribedSettings;
  settingsFile: string;
  models: { id: string; name: string }[];
  defaultModel: string;
  /** Every address this gateway may contact, by purpose. */
  hosts: { purpose: string; host: string }[];
}

export interface AppController {
  state(): Promise<AppState>;
  setSetting(key: string, value: unknown): Promise<AppState>;
  /** Start signing in; progress shows in the state. */
  signIn(): Promise<AppState>;
  sendTest(model: string): Promise<TestResult>;
  /** Called whenever the state changes. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export interface AppControllerOptions {
  context: "app" | "opencode";
  facts: GatewayFacts;
  tokens: Pick<TokenClient, "account" | "invalidate">;
  settings: SettingsStore;
  /** This gateway's proxy, which the test message goes through like any request. */
  proxy: { url: string; apiKey: string };
  /** Interactive sign-in. Given only to the standalone app. */
  signIn?: (browser: SignInBrowser) => Promise<string>;
  pluginDir?: string;
  opencodeConfigPath?: string;
}

export function createAppController(options: AppControllerOptions): AppController {
  const listeners = new Set<() => void>();
  const pluginDir = options.pluginDir ?? thisCheckout().pluginDir;
  let signingIn = false;
  let signInError: string | undefined;
  let testing = false;
  let lastTest: TestResult | undefined;

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* a page that went away cannot stop the next one hearing */
      }
    }
  };
  options.settings.onChange(notify);

  const command = `node "${pluginDir}/dist/cli.mjs" login`;

  const state = async (): Promise<AppState> => {
    let account: string | null = null;
    try {
      account = (await options.tokens.account()) ?? null;
    } catch {
      account = null;
    }
    return {
      context: options.context,
      facts: options.facts,
      account,
      signIn: { available: Boolean(options.signIn), running: signingIn, ...(signInError ? { error: signInError } : {}), command },
      test: { running: testing, prompt: TEST_PROMPT, ...(lastTest ? { last: lastTest } : {}) },
      opencode: { ...openCodeStatus(pluginDir, options.opencodeConfigPath), pluginDir, quietSettings: { ...OPENCODE_QUIET } },
      settings: options.settings.describe(),
      settingsFile: options.settings.file,
      models: testModels(),
      defaultModel: DEFAULT_MODEL,
      hosts: Object.entries(ALLOWED_HOSTS).map(([purpose, host]) => ({ purpose, host })),
    };
  };

  return {
    state,
    async setSetting(key, value) {
      options.settings.set(key, value);
      return state();
    },
    async signIn() {
      if (!options.signIn) throw new Error(`Sign in from a terminal instead: ${command}`);
      if (!signingIn) {
        signingIn = true;
        signInError = undefined;
        notify();
        void options
          .signIn(options.settings.current().signInBrowser)
          .then(() => options.tokens.invalidate())
          .catch((error: unknown) => {
            signInError = error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            signingIn = false;
            notify();
          });
      }
      return state();
    },
    async sendTest(model) {
      if (!testModels().some((candidate) => candidate.id === model)) throw new Error(`Unknown model: ${model}`);
      if (testing) throw new Error("A test message is already on its way.");
      testing = true;
      notify();
      const session = `${TEST_SESSION_PREFIX}${randomUUID().slice(0, 8)}`;
      const started = Date.now();
      try {
        const response = await fetch(`${options.proxy.url}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.proxy.apiKey}`,
            "Content-Type": "application/json",
            [SESSION_ID_HEADER]: session,
          },
          body: JSON.stringify({ model, messages: [{ role: "user", content: TEST_PROMPT }] }),
        });
        const body = (await response.json().catch(() => ({}))) as any;
        const base = { model, at: new Date().toISOString(), ms: Date.now() - started, session };
        lastTest = response.ok
          ? { ...base, ok: true, reply: String(body?.choices?.[0]?.message?.content ?? "") }
          : { ...base, ok: false, error: String(body?.error?.message ?? `HTTP ${response.status}`), ...(body?.error?.code ? { code: String(body.error.code) } : {}) };
      } catch (error) {
        lastTest = { model, at: new Date().toISOString(), ms: Date.now() - started, session, ok: false, error: String((error as Error)?.message ?? error) };
      } finally {
        testing = false;
        notify();
      }
      return lastTest;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One entry per model Copilot serves, aliases folded, in the catalogue's order. */
export function testModels(): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const model of MODELS) {
    if (model.tone === null) continue;
    const name = model.name.replace(/^Code · /, "");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: model.id, name });
  }
  return out;
}
