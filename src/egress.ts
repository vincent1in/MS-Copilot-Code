/**
 * The egress allowlist: the only hosts this package may send anything to.
 *
 * Every outbound request this package makes is checked here before a socket opens:
 * the chat WebSocket, the image upload, MSAL's token traffic (through
 * {@link createGuardedNetworkClient}), and Power Platform when the opt-in Copilot
 * Studio agent is enabled. Each call site names its purpose, so a token minted for
 * one service cannot be sent to another service's host, and a host learned from a
 * server response (the Power Platform environment) must still match a fixed pattern.
 *
 * Loopback is allowed for every purpose: the test suite points the client at a stub
 * on 127.0.0.1, and nothing on loopback leaves the machine.
 *
 * Scope, stated plainly: this guards this package's own code. It does not patch
 * globals — the plugin runs inside opencode's process, and opencode's own traffic is
 * not ours to police — and it does not cover the browser window that
 * `opencode-m365 login` opens, which shows Microsoft's (or your IdP's) sign-in pages
 * and loads whatever assets they reference.
 */

import type { INetworkModule, NetworkRequestOptions, NetworkResponse } from "@azure/msal-node";

export type EgressPurpose = "auth" | "chat" | "studio";

/** `<environment id>.<2 chars>.environment.api.powerplatform.com`, nothing else. */
const POWER_PLATFORM_ENVIRONMENT_HOST = /^[a-z0-9]{1,63}\.[a-z0-9]{2}\.environment\.api\.powerplatform\.com$/;

const ALLOWED: Record<EgressPurpose, (host: string) => boolean> = {
  auth: (host) => host === "login.microsoftonline.com",
  chat: (host) => host === "substrate.office.com",
  studio: (host) => host === "api.bap.microsoft.com" || POWER_PLATFORM_ENVIRONMENT_HOST.test(host),
};

/** Human-readable allowlist, for docs and `opencode-m365 doctor`. */
export const ALLOWED_HOSTS: Readonly<Record<EgressPurpose, readonly string[]>> = {
  auth: ["login.microsoftonline.com"],
  chat: ["substrate.office.com"],
  studio: ["api.bap.microsoft.com", "*.environment.api.powerplatform.com"],
};

export class EgressDeniedError extends Error {
  readonly code = "EGRESS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "EgressDeniedError";
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Is `host` a Power Platform environment host the Studio agent may call? */
export function isPowerPlatformEnvironmentHost(host: string): boolean {
  return POWER_PLATFORM_ENVIRONMENT_HOST.test(host.toLowerCase());
}

/**
 * Check `target` against the allowlist for `purpose`. Returns the parsed URL, or
 * throws {@link EgressDeniedError}. The error names the host only, never the full
 * URL: the chat URL carries the access token in its query string.
 */
export function assertEgress(purpose: EgressPurpose, target: string | URL): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new EgressDeniedError(`refusing a ${purpose} request: not a valid URL`);
  }
  if (url.username || url.password) {
    throw new EgressDeniedError(`refusing a ${purpose} request: the URL carries credentials`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHostname(host)) {
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return url;
    throw new EgressDeniedError(`refusing a ${purpose} request: unsupported scheme ${url.protocol}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new EgressDeniedError(`refusing a ${purpose} request to ${host}: only TLS (https/wss) may leave this machine`);
  }
  if (url.port !== "" && url.port !== "443") {
    throw new EgressDeniedError(`refusing a ${purpose} request to ${host}:${url.port}: only port 443 may leave this machine`);
  }
  if (!ALLOWED[purpose](host)) {
    throw new EgressDeniedError(`refusing a ${purpose} request to ${host}: not on the egress allowlist`);
  }
  return url;
}

/**
 * MSAL's network client, with every request checked against the `auth` allowlist.
 *
 * Mirrors MSAL's own fetch-based `HttpClient` (which msal-node does not export, so it
 * cannot be wrapped): same methods, same `{ headers, body, status }` shape, JSON body,
 * optional timeout on GET. Passed as `system.networkClient`, it replaces MSAL's
 * default, so token traffic can only ever reach `login.microsoftonline.com`.
 */
export function createGuardedNetworkClient(doFetch: typeof globalThis.fetch = (input, init) => fetch(input, init)): INetworkModule {
  async function send<T>(
    method: "GET" | "POST",
    rawUrl: string,
    options?: NetworkRequestOptions,
    timeout?: number,
  ): Promise<NetworkResponse<T>> {
    const url = assertEgress("auth", rawUrl);
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(options?.headers ?? {})) headers.append(key, value);
    try {
      const response = await doFetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(method === "POST" ? { body: options?.body ?? "" } : {}),
      });
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      return { headers: responseHeaders, body: (await response.json()) as T, status: response.status };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions, timeout?: number) =>
      send<T>("GET", url, options, timeout),
    sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) => send<T>("POST", url, options),
  };
}
