import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { uploadImage } from "./image.js";
import { ALLOWED_HOSTS, assertEgress, createGuardedNetworkClient, EgressDeniedError, type EgressPurpose } from "./egress.js";

describe("assertEgress", () => {
  it.each([
    ["auth", "https://login.microsoftonline.com/common/oauth2/v2.0/token"],
    ["chat", "wss://substrate.office.com/m365Copilot/Chathub/oid@tid?access_token=x"],
    ["chat", "https://substrate.office.com/m365Copilot/UploadFile"],
  ] as const)("allows %s → %s", (purpose, url) => {
    expect(assertEgress(purpose, url).hostname).toBe(new URL(url).hostname);
  });

  it.each([
    ["chat", "https://login.microsoftonline.com/common", "a chat request to the auth host"],
    ["auth", "https://substrate.office.com/x", "an auth request to the chat host"],
    ["chat", "https://api.bap.microsoft.com/x", "Power Platform (Copilot Studio is removed)"],
    ["auth", "https://defaultabc.89.environment.api.powerplatform.com/x", "a Power Platform environment"],
    ["chat", "wss://substrate.office.com.evil.example/x", "a look-alike suffix"],
    ["chat", "wss://evil.example/x?substrate.office.com", "the host in the query"],
    ["chat", "ws://substrate.office.com/x", "plaintext ws to a remote host"],
    ["auth", "http://login.microsoftonline.com/x", "plaintext http to a remote host"],
    ["chat", "wss://substrate.office.com:8443/x", "a non-443 port"],
    ["chat", "wss://user:pass@substrate.office.com/x", "credentials in the URL"],
    ["chat", "https://evil.example/copilotstudio", "an arbitrary host"],
    ["auth", "file:///etc/passwd", "a non-network scheme"],
    ["auth", "not a url", "garbage"],
  ] as const)("refuses %s → %s (%s)", (purpose, url, _why) => {
    expect(() => assertEgress(purpose, url)).toThrow(EgressDeniedError);
  });

  it("allows loopback for any purpose, which is where the test stub lives", () => {
    expect(assertEgress("chat", "ws://127.0.0.1:4567/m365Copilot/Chathub/x").port).toBe("4567");
    expect(assertEgress("auth", "http://localhost:1/").hostname).toBe("localhost");
    expect(assertEgress("chat", "http://[::1]:2/").hostname).toBe("[::1]");
  });

  it("knows exactly two hosts, and nothing for a purpose it does not know", () => {
    expect(ALLOWED_HOSTS).toEqual({ auth: "login.microsoftonline.com", chat: "substrate.office.com" });
    expect(() => assertEgress("studio" as EgressPurpose, "https://api.bap.microsoft.com/x")).toThrow(EgressDeniedError);
  });

  it("never echoes the URL's query string, which can hold the access token", () => {
    try {
      assertEgress("chat", "wss://evil.example/x?access_token=SECRET-TOKEN");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-TOKEN");
      expect(String(error)).toContain("evil.example");
    }
  });
});

describe("createGuardedNetworkClient (MSAL)", () => {
  it("refuses a non-login host without ever calling fetch", async () => {
    const doFetch = vi.fn();
    const client = createGuardedNetworkClient(doFetch);
    await expect(client.sendGetRequestAsync("https://evil.example/common/discovery")).rejects.toThrow(EgressDeniedError);
    await expect(client.sendPostRequestAsync("https://login.microsoftonline.com.evil.example/token", { body: "x" })).rejects.toThrow(
      EgressDeniedError,
    );
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("passes login.microsoftonline.com through and returns MSAL's response shape", async () => {
    const doFetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ access_token: "t" }), {
      status: 200,
      headers: { "content-type": "application/json", "x-ms-request-id": "r1" },
    }));
    const client = createGuardedNetworkClient(doFetch as unknown as typeof fetch);
    const response = await client.sendPostRequestAsync<{ access_token: string }>(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token" },
    );
    expect(response).toEqual({ status: 200, body: { access_token: "t" }, headers: expect.objectContaining({ "x-ms-request-id": "r1" }) });
    const [, init] = doFetch.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe("grant_type=refresh_token");
  });
});

describe("redirects are never followed", () => {
  // A 307 would re-send the request body (a refresh token, an image) to a host the
  // allowlist never saw. A real server on loopback answers with one; the target of the
  // redirect must receive nothing.
  async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; origin: string }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  }

  async function withRedirect(run: (redirector: string, hits: () => number) => Promise<void>): Promise<void> {
    let targetHits = 0;
    const target = await listen((_request, response) => {
      targetHits += 1;
      response.end("{}");
    });
    const redirector = await listen((_request, response) => {
      response.writeHead(307, { Location: `${target.origin}/stolen` });
      response.end();
    });
    try {
      await run(redirector.origin, () => targetHits);
    } finally {
      redirector.server.close();
      target.server.close();
    }
  }

  it("by MSAL's guarded network client", async () => {
    await withRedirect(async (origin, hits) => {
      const client = createGuardedNetworkClient();
      await expect(
        client.sendPostRequestAsync(`${origin}/common/oauth2/v2.0/token`, { body: "grant_type=refresh_token&refresh_token=SECRET" }),
      ).rejects.toThrow();
      await expect(client.sendGetRequestAsync(`${origin}/common/discovery`)).rejects.toThrow();
      expect(hits()).toBe(0);
    });
  });

  it("by the image upload", async () => {
    await withRedirect(async (origin, hits) => {
      await expect(
        uploadImage("data:image/png;base64,iVBORw0KGgo=", { token: "t", conversationId: "c", origin }),
      ).rejects.toThrow();
      expect(hits()).toBe(0);
    });
  });
});

describe("onEgress", () => {
  it("hears every decision, by host only, and can stop listening", async () => {
    const { onEgress } = await import("./egress.js");
    const heard: unknown[] = [];
    const stop = onEgress((decision) => heard.push(decision));
    assertEgress("chat", "wss://substrate.office.com/m365Copilot/Chathub/o@t?access_token=SECRET");
    expect(() => assertEgress("auth", "https://login.evil.example/token?refresh_token=SECRET")).toThrow(EgressDeniedError);
    assertEgress("chat", "ws://127.0.0.1:9/x");
    stop();
    assertEgress("chat", "wss://substrate.office.com/x");
    expect(heard).toEqual([
      { purpose: "chat", host: "substrate.office.com", allowed: true, loopback: false },
      {
        purpose: "auth",
        host: "login.evil.example",
        allowed: false,
        loopback: false,
        reason: "refusing a auth request to login.evil.example: not on the egress allowlist",
      },
      { purpose: "chat", host: "127.0.0.1", allowed: true, loopback: true },
    ]);
    expect(JSON.stringify(heard)).not.toContain("SECRET");
  });

  it("cannot be swayed by a listener that throws", async () => {
    const { onEgress } = await import("./egress.js");
    const stop = onEgress(() => {
      throw new Error("listener bug");
    });
    try {
      expect(assertEgress("chat", "wss://substrate.office.com/x").hostname).toBe("substrate.office.com");
      expect(() => assertEgress("chat", "wss://evil.example/x")).toThrow(EgressDeniedError);
    } finally {
      stop();
    }
  });

  it("names a target that is not a URL without echoing it", async () => {
    const { onEgress } = await import("./egress.js");
    const heard: { host: string }[] = [];
    const stop = onEgress((decision) => heard.push(decision));
    expect(() => assertEgress("chat", "not a url access_token=SECRET")).toThrow(EgressDeniedError);
    stop();
    expect(heard[0]!.host).toBe("(not a valid URL)");
  });
});

describe("MSAL's reports about itself", () => {
  it("are taken off token requests before they leave: body, query and headers", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createGuardedNetworkClient(doFetch as unknown as typeof fetch);
    const body = [
      "client_id=c0ab8ce9",
      "scope=https%3A%2F%2Fsubstrate.office.com%2Fsydney%2Fsydney.readwrite%20offline_access",
      "grant_type=refresh_token",
      "refresh_token=0.AAAA-rt_value",
      "x-client-SKU=msal.js.node",
      "x-client-VER=7.2.1",
      "x-client-OS=linux",
      "x-client-CPU=x64",
      "x-client-current-telemetry=5%7C61%2C0%2C%2C%2C%7C%2C",
      "x-client-last-telemetry=5%7C0%7C%7C%7C0%2C0",
      "x-ms-lib-capability=retry-after%2C%20h429",
    ].join("&");
    await client.sendPostRequestAsync("https://login.microsoftonline.com/common/oauth2/v2.0/token?client-request-id=abc&x-client-SKU=msal.js.node", {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8", "x-client-current-telemetry": "5|61" },
    });
    const [url, init] = doFetch.mock.calls[0] as unknown as [URL, RequestInit];
    const sent = new URLSearchParams(String(init.body));
    expect([...sent.keys()]).toEqual(["client_id", "scope", "grant_type", "refresh_token", "x-ms-lib-capability"]);
    expect(sent.get("scope")).toBe("https://substrate.office.com/sydney/sydney.readwrite offline_access");
    expect(sent.get("refresh_token")).toBe("0.AAAA-rt_value");
    expect(String(url)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token?client-request-id=abc");
    expect((init.headers as Headers).has("x-client-current-telemetry")).toBe(false);
  });

  it("leaves a body without them exactly as it was", async () => {
    const doFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createGuardedNetworkClient(doFetch as unknown as typeof fetch);
    await client.sendPostRequestAsync("https://login.microsoftonline.com/x", { body: "a=1&b=%2B", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect((doFetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body).toBe("a=1&b=%2B");
  });

  it("are taken off the sign-in address too", async () => {
    const { withoutLibraryTelemetry } = await import("./egress.js");
    const url = new URL("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&x-client-SKU=msal.js.node&x-client-VER=7&code_challenge=c&x-client-OS=darwin");
    expect(withoutLibraryTelemetry(url).toString()).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&code_challenge=c");
  });
});
