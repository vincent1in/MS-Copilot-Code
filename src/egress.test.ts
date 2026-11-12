import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { uploadImage } from "./image.js";
import { assertEgress, createGuardedNetworkClient, EgressDeniedError, isPowerPlatformEnvironmentHost } from "./egress.js";

const PP_HOST = "defaultabcdef0123456789abcdef01234567.89.environment.api.powerplatform.com";

describe("assertEgress", () => {
  it.each([
    ["auth", "https://login.microsoftonline.com/common/oauth2/v2.0/token"],
    ["chat", "wss://substrate.office.com/m365Copilot/Chathub/oid@tid?access_token=x"],
    ["chat", "https://substrate.office.com/m365Copilot/UploadFile"],
    ["studio", "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01"],
    ["studio", `https://${PP_HOST}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`],
  ] as const)("allows %s → %s", (purpose, url) => {
    expect(assertEgress(purpose, url).hostname).toBe(new URL(url).hostname);
  });

  it.each([
    ["chat", "https://login.microsoftonline.com/common", "a chat request to the auth host"],
    ["auth", "https://substrate.office.com/x", "an auth request to the chat host"],
    ["chat", "https://api.bap.microsoft.com/x", "a chat request to Power Platform"],
    ["chat", "wss://substrate.office.com.evil.example/x", "a look-alike suffix"],
    ["chat", "wss://evil.example/x?substrate.office.com", "the host in the query"],
    ["chat", "ws://substrate.office.com/x", "plaintext ws to a remote host"],
    ["auth", "http://login.microsoftonline.com/x", "plaintext http to a remote host"],
    ["chat", "wss://substrate.office.com:8443/x", "a non-443 port"],
    ["chat", "wss://user:pass@substrate.office.com/x", "credentials in the URL"],
    ["studio", "https://evil.example/copilotstudio", "an arbitrary host"],
    ["studio", "https://a.b.c.environment.api.powerplatform.com/x", "the wrong label shape"],
    ["auth", "file:///etc/passwd", "a non-network scheme"],
    ["auth", "not a url", "garbage"],
  ] as const)("refuses %s → %s (%s)", (purpose, url, _why) => {
    expect(() => assertEgress(purpose, url)).toThrow(EgressDeniedError);
  });

  it("allows loopback for any purpose, which is where the test stub lives", () => {
    expect(assertEgress("chat", "ws://127.0.0.1:4567/m365Copilot/Chathub/x").port).toBe("4567");
    expect(assertEgress("auth", "http://localhost:1/").hostname).toBe("localhost");
    expect(assertEgress("studio", "http://[::1]:2/").hostname).toBe("[::1]");
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

describe("isPowerPlatformEnvironmentHost", () => {
  it("accepts the environment host shape and nothing else", () => {
    expect(isPowerPlatformEnvironmentHost(PP_HOST)).toBe(true);
    expect(isPowerPlatformEnvironmentHost(`${PP_HOST}.evil.example`)).toBe(false);
    expect(isPowerPlatformEnvironmentHost("environment.api.powerplatform.com")).toBe(false);
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
