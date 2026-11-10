import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrCreateAgent } from "./agent.js";
import { startRuntime, type M365Runtime } from "./runtime.js";

// Stand-in for the Copilot Studio provisioning, so a test can see whether the
// runtime ever reaches for it without any network or tenant involved.
vi.mock("./agent.js", () => ({ getOrCreateAgent: vi.fn(async () => null) }));

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

describe("the Copilot Studio agent", () => {
  const savedStudio = process.env.M365_STUDIO_AGENT;
  afterEach(() => {
    vi.mocked(getOrCreateAgent).mockClear();
    if (savedStudio === undefined) delete process.env.M365_STUDIO_AGENT;
    else process.env.M365_STUDIO_AGENT = savedStudio;
  });

  /** One tool-carrying turn through the in-process proxy; its outcome does not matter. */
  async function toolTurn(rt: M365Runtime): Promise<void> {
    const response = await fetch(`${rt.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rt.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "quick",
        messages: [{ role: "user", content: "read the file" }],
        tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { filePath: { type: "string" } } } } }],
      }),
    });
    await response.text();
  }

  it("is never provisioned by default, even on a tool turn", async () => {
    delete process.env.M365_STUDIO_AGENT;
    runtime = await startRuntime({});
    await toolTurn(runtime);
    expect(getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("is provisioned on a tool turn when opted in", async () => {
    delete process.env.M365_STUDIO_AGENT;
    runtime = await startRuntime({ studioAgent: true });
    await toolTurn(runtime);
    expect(getOrCreateAgent).toHaveBeenCalledTimes(1);
  });
});
