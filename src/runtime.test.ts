import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listMonitorLinks } from "./monitor/links.js";
import { startRuntime as startRuntimeWith, type M365Runtime } from "./runtime.js";

/** Every runtime here reads a private, empty settings file, never the real one. */
const settingsFile = () => join(mkdtempSync(join(tmpdir(), "m365-runtime-")), "settings.json");
const startRuntime = (options?: Record<string, unknown>, file = settingsFile()) => startRuntimeWith(options, { settingsFile: file });

let runtime: M365Runtime | undefined;
const savedKey = process.env.M365_PROXY_KEY;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (savedKey === undefined) delete process.env.M365_PROXY_KEY;
  else process.env.M365_PROXY_KEY = savedKey;
});

describe("the proxy secret the plugin hands opencode", () => {
  it("is the one the in-process proxy actually demands", async () => {
    runtime = await startRuntime({});
    expect(runtime.apiKey.length).toBeGreaterThanOrEqual(43);

    const authed = await fetch(`${runtime.baseUrl}/models`, { headers: { Authorization: `Bearer ${runtime.apiKey}` } });
    expect(authed.status).toBe(200);
    const anonymous = await fetch(`${runtime.baseUrl}/models`);
    expect(anonymous.status).toBe(401);
  });

  it("comes from the apiKey option when attaching to an external proxy", async () => {
    process.env.M365_PROXY_KEY = "from-env";
    runtime = await startRuntime({ baseUrl: "http://127.0.0.1:4141/v1", apiKey: "from-option" });
    expect(runtime.apiKey).toBe("from-option");
  });

  it("refuses a remote baseUrl and starts the in-process proxy instead", async () => {
    runtime = await startRuntime({ baseUrl: "https://evil.example/v1", apiKey: "k" });
    expect(new URL(runtime.baseUrl).hostname).toBe("127.0.0.1");
    expect(runtime.apiKey).not.toBe("k");
  });

  it("falls back to M365_PROXY_KEY for an external proxy", async () => {
    process.env.M365_PROXY_KEY = "from-env";
    runtime = await startRuntime({ baseUrl: "http://127.0.0.1:4141/v1" });
    expect(runtime.apiKey).toBe("from-env");
  });

  it("uses M365_PROXY_KEY for the in-process proxy too, when set", async () => {
    process.env.M365_PROXY_KEY = "a-shared-secret-for-the-in-process-proxy";
    runtime = await startRuntime({});
    expect(runtime.apiKey).toBe("a-shared-secret-for-the-in-process-proxy");
  });
});

describe("settings in the plugin", () => {
  it("reads plugin options as settings, and ignores the removed studioAgent", async () => {
    runtime = await startRuntime({ studioAgent: true, workIq: "flag" });
    expect(runtime.settings.describe().workIq).toMatchObject({ value: "flag", source: "opencode" });
    expect(Object.keys(runtime.settings.current())).not.toContain("studioAgent");
  });

  it("starts no page unless the setting asks for one", async () => {
    const before = listMonitorLinks().length;
    runtime = await startRuntime({});
    expect(listMonitorLinks().length).toBe(before);
  });

  it("starts the page when the saved setting asks for it, and removes its link on close", async () => {
    const file = settingsFile();
    writeFileSync(file, JSON.stringify({ pageWithOpenCode: "on" }));
    const before = listMonitorLinks().length;
    runtime = await startRuntime({}, file);
    expect(listMonitorLinks().length).toBe(before + 1);
    await runtime.close();
    runtime = undefined;
    expect(listMonitorLinks().length).toBe(before);
  });
});
