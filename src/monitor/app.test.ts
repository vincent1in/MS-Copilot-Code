import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completion, startStubCopilot, streamItem, type StubServer } from "../../test/stub-copilot.js";
import { startServer, type ProxyHandle } from "../server.js";
import { SettingLockedError, createSettingsStore } from "../settings.js";
import { TEST_PROMPT, TEST_SESSION_PREFIX, createAppController, testModels } from "./app.js";
import type { MonitorEvent } from "./events.js";
import { createMonitor } from "./monitor.js";

function fakeToken(): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ oid: "oid", tid: "tid" })}.sig`;
}

const temp = () => mkdtempSync(join(tmpdir(), "m365-app-"));
const facts = { context: "app" as const, proxy: "http://127.0.0.1:1", pid: 1, defaultModel: "gpt-6.1-sol", startedAt: "2026-11-12T12:00:00.000Z" };

let stub: StubServer | undefined;
let proxy: ProxyHandle | undefined;
afterEach(async () => {
  await proxy?.close();
  await stub?.close();
  proxy = undefined;
  stub = undefined;
});

function controller(overrides: Partial<Parameters<typeof createAppController>[0]> = {}) {
  const dir = temp();
  const settings = createSettingsStore({ file: join(dir, "settings.json"), env: {} });
  const tokens = { account: vi.fn(async () => "alice@contoso.com" as string | undefined), invalidate: vi.fn() };
  const app = createAppController({
    context: "app",
    facts,
    tokens,
    settings,
    proxy: { url: "http://127.0.0.1:1", apiKey: "k" },
    pluginDir: join(dir, "gateway"),
    opencodeConfigPath: join(dir, "opencode.json"),
    ...overrides,
  });
  return { app, settings, tokens, dir };
}

describe("the Set up page's state", () => {
  it("says who is signed in, from the cache, and what OpenCode needs", async () => {
    const { app, dir } = controller();
    const state = await app.state();
    expect(state.account).toBe("alice@contoso.com");
    const cli = join(dir, "gateway", "dist", "cli.mjs");
    expect(state.signIn).toEqual({ available: false, running: false, command: `node "${cli}" login` });
    // Nothing puts an `opencode-m365` command on the PATH, so every command shown runs from any folder.
    expect(state.commands).toEqual({ login: `node "${cli}" login`, open: `node "${cli}" open`, setup: `node "${cli}" setup --quiet` });
    expect(state.opencode).toMatchObject({ connected: false, pluginDir: join(dir, "gateway"), quietSettings: { update: "disable", share: "disabled", websearch: false } });
    expect(state.hosts).toEqual([
      { purpose: "auth", host: "login.microsoftonline.com" },
      { purpose: "chat", host: "substrate.office.com" },
    ]);
    expect(state.models[0]).toEqual({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol (recommended)" });
    expect(state.settings.workIq.value).toBe("hold");
  });

  it("shows OpenCode as connected once its config names this folder", async () => {
    const { app, dir } = controller();
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugins: [join(dir, "gateway")] }));
    expect((await app.state()).opencode.connected).toBe(true);
  });

  it("treats an unreadable cache as nobody signed in", async () => {
    const { app } = controller({ tokens: { account: async () => Promise.reject(new Error("bad cache")), invalidate: () => {} } });
    expect((await app.state()).account).toBeNull();
  });
});

describe("Settings", () => {
  it("saves a setting and tells open pages", async () => {
    const { app } = controller();
    const heard = vi.fn();
    app.onChange(heard);
    const state = await app.setSetting("workIq", "flag");
    expect(state.settings.workIq).toEqual({ value: "flag", source: "saved" });
    expect(heard).toHaveBeenCalled();
  });

  it("refuses a setting pinned elsewhere", async () => {
    const dir = temp();
    const settings = createSettingsStore({ file: join(dir, "s.json"), env: { M365_WEB_SEARCH: "1" } });
    const { app } = controller({ settings });
    await expect(app.setSetting("webSearch", false)).rejects.toThrow(SettingLockedError);
  });
});

describe("signing in", () => {
  it("is only offered by the standalone app", async () => {
    const { app } = controller();
    await expect(app.signIn()).rejects.toThrow(/terminal/);
  });

  it("runs in the background with the chosen browser, then forgets stale tokens", async () => {
    let finish!: (account: string) => void;
    const signIn = vi.fn((_browser: string) => new Promise<string>((resolve) => (finish = resolve)));
    const { app, settings, tokens } = controller({ signIn });
    settings.set("signInBrowser", "chrome");
    const started = await app.signIn();
    expect(started.signIn).toMatchObject({ available: true, running: true });
    expect(signIn).toHaveBeenCalledWith("chrome");
    await app.signIn();
    expect(signIn).toHaveBeenCalledTimes(1);
    finish("alice@contoso.com");
    await vi.waitFor(async () => expect((await app.state()).signIn.running).toBe(false));
    expect(tokens.invalidate).toHaveBeenCalled();
  });

  it("shows why it failed", async () => {
    const { app } = controller({ signIn: async () => Promise.reject(new Error("Could not open a browser")) });
    await app.signIn();
    await vi.waitFor(async () => expect((await app.state()).signIn).toMatchObject({ running: false, error: "Could not open a browser" }));
  });
});

describe("connecting OpenCode", () => {
  it("adds this folder to OpenCode's config, keeps everything else, and saves the old file first", async () => {
    const { app, dir } = controller();
    const config = join(dir, "opencode.json");
    const before = `${JSON.stringify({ theme: "tokyonight", plugins: ["/elsewhere/other-plugin"] }, null, 2)}\n`;
    writeFileSync(config, before);

    const state = await app.connectOpenCode(true);

    const after = JSON.parse(readFileSync(config, "utf8"));
    expect(after.theme).toBe("tokyonight");
    expect(after.plugins).toEqual(["/elsewhere/other-plugin", join(dir, "gateway")]);
    expect(after).toMatchObject({ update: "disable", share: "disabled", websearch: false });
    expect(readFileSync(`${config}.bak`, "utf8")).toBe(before);
    expect(state.opencode).toMatchObject({ connected: true, canConnect: true, quiet: { update: true, share: true, websearch: true } });
    expect(state.opencode.lastConnect).toMatchObject({ quiet: true, backupPath: `${config}.bak` });
  });

  it("leaves OpenCode's own traffic settings alone unless asked, and running it twice changes nothing more", async () => {
    const { app, dir } = controller();
    const config = join(dir, "opencode.json");
    await app.connectOpenCode(false);
    const once = readFileSync(config, "utf8");
    expect(JSON.parse(once)).toEqual({ plugins: [join(dir, "gateway")] });
    await app.connectOpenCode(false);
    expect(readFileSync(config, "utf8")).toBe(once);
  });

  it("refuses a config it can't read, and never rewrites an opencode.jsonc", async () => {
    const broken = controller();
    writeFileSync(join(broken.dir, "opencode.json"), "{ not json");
    await expect(broken.app.connectOpenCode(true)).rejects.toThrow(/not valid JSON, so it was left alone/);
    expect(readFileSync(join(broken.dir, "opencode.json"), "utf8")).toBe("{ not json");

    const commented = controller();
    writeFileSync(join(commented.dir, "opencode.jsonc"), "{\n  // mine\n}\n");
    expect((await commented.app.state()).opencode.jsoncPath).toBe(join(commented.dir, "opencode.jsonc"));
    await expect(commented.app.connectOpenCode(true)).rejects.toThrow(/can hold comments/);
    expect(existsSync(join(commented.dir, "opencode.json"))).toBe(false);
  });

  it("is only offered by the standalone app: inside OpenCode it is already connected", async () => {
    const { app } = controller({ context: "opencode" });
    expect((await app.state()).opencode.canConnect).toBe(false);
    await expect(app.connectOpenCode(true)).rejects.toThrow(/already running this gateway/);
  });
});

describe("the test message", () => {
  it("goes through the gateway like any request, and shows up in Traffic", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem("Got it, the connection works."), completion()] });
    const monitor = createMonitor();
    proxy = await startServer({ getToken: async () => fakeToken(), endpoint: stub.origin, monitor });
    const { app } = controller({ proxy: { url: proxy.url, apiKey: proxy.apiKey } });

    const result = await app.sendTest("gpt-6.1-sol");
    expect(result).toMatchObject({ ok: true, model: "gpt-6.1-sol", reply: "Got it, the connection works." });
    expect(result.session.startsWith(TEST_SESSION_PREFIX)).toBe(true);
    expect(stub.last().frames.find((frame) => frame.target === "chat").arguments[0].message.text).toBe(TEST_PROMPT);

    const request = monitor.snapshot().find((event): event is Extract<MonitorEvent, { kind: "request" }> => event.kind === "request");
    expect(request?.session).toBe(result.session);
    expect((await app.state()).test.last).toEqual(result);
  });

  it("reports a refusal in plain words", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem("Sorry", { contentOrigin: "BotConnection" }), completion()] });
    proxy = await startServer({ getToken: async () => fakeToken(), endpoint: stub.origin });
    const { app } = controller({ proxy: { url: proxy.url, apiKey: proxy.apiKey } });
    const result = await app.sendTest("quick");
    expect(result).toMatchObject({ ok: false, code: "m365_not_served" });
    expect(result.error).toMatch(/could not serve/);
  });

  it("only sends to a model Copilot serves", async () => {
    const { app } = controller();
    await expect(app.sendTest("gpt-99")).rejects.toThrow(/Unknown model/);
    await expect(app.sendTest("local-title")).rejects.toThrow(/Unknown model/);
  });

  it("lists each Copilot model once, aliases folded", () => {
    const names = testModels().map((model) => model.name);
    expect(new Set(names).size).toBe(names.length);
    expect(testModels().some((model) => model.id === "local-title")).toBe(false);
  });
});
