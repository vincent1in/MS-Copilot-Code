/**
 * The page's listener (the gateway app's UI): a second loopback server, separate from
 * the proxy.
 *
 * The proxy refuses every browser outright; this one exists to be opened in a browser,
 * so it gets its own port (and therefore its own origin) and the proxy's rules stay
 * exactly as they were. What it serves is sensitive — every prompt, file and reply of
 * the session — so:
 *
 * - It binds loopback only, and refuses any `Host` that is not a loopback name on its
 *   own port (DNS rebinding).
 * - The page is static and carries no data. The data endpoints need a per-launch
 *   secret in an `Authorization` header. The secret reaches the page in the link's
 *   URL fragment, which browsers never send to any server, and the page takes it out
 *   of the address bar on load.
 * - A request from another origin is refused, preflights are never granted, and no
 *   CORS header is ever sent, so other pages can neither read nor clear the log.
 * - Responses forbid framing, sniffing, caching and referrers, and the page's content
 *   security policy allows only its own script and style: model output is rendered as
 *   text, and could not run even if it were not.
 * - Changes go through a short list of JSON endpoints (save a setting, sign in, send a
 *   test message, clear the log), each something the user clicked,
 *   each with the same key and origin checks, and each validating its input.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { SettingLockedError, SettingValueError } from "../settings.js";
import type { AppController } from "./app.js";
import type { GatewayFacts, MonitorEvent } from "./events.js";
import { MONITOR_LIMITS, type Monitor } from "./monitor.js";

export interface MonitorServerOptions {
  monitor: Monitor;
  /** Which gateway this is, for the page's header. */
  facts?: GatewayFacts;
  /** The Set up and Settings backend. Without it the page shows Traffic and Checks only. */
  app?: AppController;
  /** Loopback only: `127.0.0.1` (the default), `::1` or `localhost`. */
  host?: string;
  port?: number;
  /** The page's secret. Omit it for a fresh random one per launch. */
  token?: string;
  /** Most pages streaming at once. */
  maxClients?: number;
  heartbeatMs?: number;
  /** Where index.html, monitor.css and monitor.js are. Defaults to `./ui/` beside this module. */
  assetsDir?: URL;
}

export interface MonitorServerHandle {
  /** The page's address, without its secret. */
  url: string;
  /** The page's address with its secret: what to open. */
  link: string;
  port: number;
  close(): Promise<void>;
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "::1", "localhost"]);

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), clipboard-read=()",
};

const ASSETS: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/monitor.css": { file: "monitor.css", type: "text/css; charset=utf-8" },
  "/monitor.js": { file: "monitor.js", type: "text/javascript; charset=utf-8" },
};

/** A slow page past this much unsent data is dropped rather than buffered without end. */
const MAX_BACKLOG_BYTES = 64 * 1024 * 1024;

/** The largest JSON body an endpoint reads. Every one of them takes a few short fields. */
const MAX_JSON_BYTES = 16 * 1024;

const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

export async function startMonitorServer(options: MonitorServerOptions): Promise<MonitorServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_NAMES.has(host)) {
    throw new Error(`Refusing to bind ${host}: the monitor only listens on loopback (127.0.0.1, ::1, localhost)`);
  }
  const token = options.token || randomBytes(32).toString("base64url");
  const maxClients = options.maxClients ?? 4;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const assets = loadAssets(options.assetsDir ?? new URL("./ui/", import.meta.url));
  const clients = new Set<ServerResponse>();
  const { monitor, app } = options;
  // Tell open pages to re-read the app state; the state itself is fetched with the key.
  const stopAppFeed = app?.onChange(() => {
    for (const client of clients) if (!client.writableEnded) client.write(`data: ${JSON.stringify({ kind: "app-changed" })}\n\n`);
  });

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      send(response, 500, TEXT, `The gateway page failed: ${String((error as Error)?.message ?? error)}`);
    });
  });

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const port = (server.address() as AddressInfo).port;
    const method = (request.method ?? "GET").toUpperCase();
    const path = new URL(request.url ?? "/", "http://localhost").pathname;

    if (!isOwnHost(request.headers.host, port)) return send(response, 403, TEXT, "Host must be this machine's loopback address.");
    if (method === "OPTIONS") return send(response, 403, TEXT, "Cross-origin requests are not supported.");
    if (!isSameOrigin(request)) return send(response, 403, TEXT, "Only the monitor page itself may call this.");

    const asset = ASSETS[path];
    if (asset) {
      if (method !== "GET" && method !== "HEAD") return send(response, 405, TEXT, "Use GET.");
      return send(response, 200, asset.type, method === "HEAD" ? "" : assets[asset.file]!);
    }
    if (path === "/favicon.ico") return send(response, 204, TEXT, "");

    if (path === "/events" || path === "/clear" || path.startsWith("/api/")) {
      if (!hasToken(request.headers.authorization, token)) {
        return send(response, 401, TEXT, "Open this page from the link `opencode-m365 open` (or `monitor`) gives; this one is missing its key.");
      }
      if (path === "/events") {
        if (method !== "GET") return send(response, 405, TEXT, "Use GET.");
        return stream(request, response);
      }
      if (path === "/clear") {
        if (method !== "POST") return send(response, 405, TEXT, "Use POST.");
        monitor.clear();
        return send(response, 204, TEXT, "");
      }
      return api(request, response, method, path);
    }

    send(response, 404, TEXT, "Not found.");
  };

  /** The Set up and Settings endpoints. */
  const api = async (request: IncomingMessage, response: ServerResponse, method: string, path: string): Promise<void> => {
    if (!app) return send(response, 404, TEXT, "This gateway has no setup page.");
    if (path === "/api/state") {
      if (method !== "GET") return send(response, 405, TEXT, "Use GET.");
      return json(response, 200, await app.state());
    }
    if (method !== "POST") return send(response, 405, TEXT, "Use POST.");
    const body = await readJson(request);
    if (body === undefined) return json(response, 400, { error: "Send a small JSON object with Content-Type: application/json." });
    try {
      switch (path) {
        case "/api/settings":
          if (typeof body.key !== "string" || !("value" in body)) return json(response, 400, { error: "Send { key, value }." });
          return json(response, 200, await app.setSetting(body.key, body.value));
        case "/api/sign-in":
          return json(response, 202, await app.signIn());
        case "/api/test":
          if (typeof body.model !== "string") return json(response, 400, { error: "Send { model }." });
          return json(response, 200, await app.sendTest(body.model));
        default:
          return json(response, 404, { error: "Not found." });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SettingValueError) return json(response, 400, { error: message });
      return json(response, error instanceof SettingLockedError ? 409 : 422, { error: message });
    }
  };

  const stream = (request: IncomingMessage, response: ServerResponse) => {
    if (clients.size >= maxClients) {
      return send(response, 429, TEXT, `The monitor is already open in ${maxClients} places. Close one and reload.`);
    }
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
    clients.add(response);

    const write = (payload: unknown) => {
      if (response.writableEnded) return;
      if (response.writableLength > MAX_BACKLOG_BYTES) {
        drop();
        return;
      }
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const unsubscribe = monitor.subscribe((event: MonitorEvent) => write(event));
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(": keepalive\n\n");
    }, heartbeatMs);
    heartbeat.unref?.();
    const drop = () => {
      clearInterval(heartbeat);
      unsubscribe();
      clients.delete(response);
      if (!response.writableEnded) response.end();
    };
    request.on("close", drop);

    write({
      kind: "hello",
      limits: MONITOR_LIMITS,
      at: new Date().toISOString(),
      setup: Boolean(app),
      ...(options.facts ? { facts: options.facts } : {}),
    });
    for (const event of monitor.snapshot()) write(event);
    write({ kind: "live" });
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return {
    url,
    link: `${url}/#k=${token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        stopAppFeed?.();
        for (const client of clients) if (!client.writableEnded) client.end();
        clients.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function loadAssets(dir: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { file } of Object.values(ASSETS)) {
    try {
      out[file] = readFileSync(new URL(file, dir), "utf8");
    } catch (error) {
      throw new Error(`The monitor page is missing ${file} (looked in ${dir.pathname}). Rebuild with \`npm run build\`. ${String(error)}`);
    }
  }
  return out;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON_TYPE, JSON.stringify(value));
}

/** A small JSON object from the request, or undefined for anything else. */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) return undefined;
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type });
  response.end(body);
}

/** A loopback name on this listener's own port, and nothing else. */
function isOwnHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim().toLowerCase());
  if (!match) return false;
  const name = match[1]!.replace(/^\[|\]$/g, "");
  return LOOPBACK_NAMES.has(name) && Number(match[2] ?? 80) === port;
}

/**
 * Was this sent by the monitor page itself (or by no page at all)?
 *
 * `Origin`, when present, must be this listener's own origin. `Sec-Fetch-Site`, which
 * every current browser sends, must say same-origin — or "none" for a page the user
 * opened directly. A tool like curl sends neither, and still needs the secret.
 */
function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${request.headers.host ?? ""}`) return false;
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/** Constant-time check of `Authorization: Bearer <token>`. */
function hasToken(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
