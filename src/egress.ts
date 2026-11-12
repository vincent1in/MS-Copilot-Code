/**
 * The egress allowlist: the only hosts this package may send anything to.
 *
 * Every outbound request this package makes is checked here before a socket opens:
 * the chat WebSocket, the image upload, and MSAL's token traffic (through
 * {@link createGuardedNetworkClient}). Each call site names its purpose, so a token
 * minted for one service cannot be sent to another service's host. There are exactly
 * two hosts: Microsoft's sign-in service and Copilot. (Upstream's Copilot Studio agent,
 * which also reached Power Platform, is removed from this fork.)
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
import { createLogger } from "./log.js";

const log = createLogger("egress");

export type EgressPurpose = "auth" | "chat";

/** The allowlist, readable: for the docs, `doctor` and the app's Set up page. */
export const ALLOWED_HOSTS: Readonly<Record<EgressPurpose, string>> = {
  auth: "login.microsoftonline.com",
  chat: "substrate.office.com",
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

/** One allowlist decision, as listeners see it. Names the host only, never the URL. */
export interface EgressDecision {
  purpose: EgressPurpose;
  host: string;
  allowed: boolean;
  /** The target is this machine (the test stub); nothing leaves it. */
  loopback: boolean;
  /** Why it was refused, when it was. */
  reason?: string;
}

const egressListeners = new Set<(decision: EgressDecision) => void>();

/**
 * Hear every allowlist decision from now on — the gateway monitor's checks trail.
 * Returns the function that stops listening. A listener that throws is ignored: it
 * can never turn a refusal into an allowance or the other way round.
 */
export function onEgress(listener: (decision: EgressDecision) => void): () => void {
  egressListeners.add(listener);
  return () => {
    egressListeners.delete(listener);
  };
}

function announce(decision: EgressDecision): void {
  for (const listener of egressListeners) {
    try {
      listener(decision);
    } catch {
      /* a listener has no say in the decision */
    }
  }
}

/**
 * Check `target` against the allowlist for `purpose`. Returns the parsed URL, or
 * throws {@link EgressDeniedError}. The error names the host only, never the full
 * URL: the chat URL carries the access token in its query string.
 */
export function assertEgress(purpose: EgressPurpose, target: string | URL): URL {
  let url: URL;
  try {
    url = checkEgress(purpose, target);
  } catch (error) {
    if (egressListeners.size > 0) {
      announce({
        purpose,
        host: hostOf(target),
        allowed: false,
        loopback: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  if (egressListeners.size > 0) {
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    announce({ purpose, host, allowed: true, loopback: isLoopbackHostname(host) });
  }
  return url;
}

/** The host of a target for a refusal notice, or a placeholder when it is not a URL. */
function hostOf(target: string | URL): string {
  try {
    return new URL(target).hostname.replace(/^\[|\]$/g, "").toLowerCase() || "(no host)";
  } catch {
    return "(not a valid URL)";
  }
}

function checkEgress(purpose: EgressPurpose, target: string | URL): URL {
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
  if (host !== ALLOWED_HOSTS[purpose]) {
    throw new EgressDeniedError(`refusing a ${purpose} request to ${host}: not on the egress allowlist`);
  }
  return url;
}

/**
 * MSAL's reports about itself, which it adds to every token request and to the sign-in
 * address: its name and version, your OS and CPU, and how earlier requests went (its
 * "server telemetry"). Microsoft's sign-in service does not need them to sign you in,
 * so they never leave this machine.
 */
const LIBRARY_TELEMETRY: ReadonlySet<string> = new Set([
  "x-client-sku",
  "x-client-ver",
  "x-client-os",
  "x-client-cpu",
  "x-client-xtra-sku",
  "x-client-current-telemetry",
  "x-client-last-telemetry",
  "x-app-name",
  "x-app-ver",
]);

const isLibraryTelemetry = (key: string) => LIBRARY_TELEMETRY.has(key.toLowerCase());

/** `url` without MSAL's reports about itself in its query string. */
export function withoutLibraryTelemetry(url: URL): URL {
  const copy = new URL(url);
  for (const key of [...copy.searchParams.keys()]) if (isLibraryTelemetry(key)) copy.searchParams.delete(key);
  return copy;
}

/** A form-encoded body without MSAL's reports about itself. */
function withoutLibraryTelemetryInForm(body: string): string {
  const params = new URLSearchParams(body);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (isLibraryTelemetry(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed ? params.toString() : body;
}

/**
 * MSAL's network client, with every request checked against the `auth` allowlist and
 * redirects refused (each hop would otherwise go unchecked). MSAL's reports about
 * itself are taken off every request first (see {@link withoutLibraryTelemetry}).
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
    let url: URL;
    try {
      url = withoutLibraryTelemetry(assertEgress("auth", rawUrl));
    } catch (error) {
      // MSAL re-wraps network errors as a generic `network_error`; keep the reason.
      log.warn(String(error));
      throw error;
    }
    const controller = new AbortController();
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(options?.headers ?? {})) {
      if (!isLibraryTelemetry(key)) headers.append(key, value);
    }
    const formBody = /application\/x-www-form-urlencoded/i.test(headers.get("content-type") ?? "");
    const body = method === "POST" ? (formBody ? withoutLibraryTelemetryInForm(options?.body ?? "") : (options?.body ?? "")) : undefined;
    try {
      const response = await doFetch(url, {
        method,
        headers,
        signal: controller.signal,
        // A redirect would send this request (a refresh token, on POST) to a host
        // the allowlist never saw. Token endpoints do not redirect; refuse.
        redirect: "error",
        ...(body !== undefined ? { body } : {}),
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
