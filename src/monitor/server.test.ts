import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMonitor, type Monitor } from "./monitor.js";
import { startMonitorServer, type MonitorServerHandle } from "./server.js";

let handle: MonitorServerHandle | undefined;
let monitor: Monitor;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

async function start() {
  monitor = createMonitor();
  handle = await startMonitorServer({ monitor, token: "test-token-0123456789", heartbeatMs: 50 });
  return handle;
}

const keyOf = (link: string) => link.split("#k=")[1]!;

/** A raw request, so the test controls Host, Origin and friends exactly. */
function raw(
  url: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; readMs?: number } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: target.hostname, port: target.port, method: options.method ?? "GET", path: options.path ?? "/", headers: options.headers ?? {} },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        res.on("end", done);
        if (options.readMs) {
          setTimeout(() => {
            req.destroy();
            done();
          }, options.readMs);
        }
      },
    );
    req.on("error", (error) => (options.readMs ? undefined : reject(error)));
    req.end();
  });
}

describe("the monitor page's listener", () => {
  it("binds loopback only", async () => {
    await expect(startMonitorServer({ monitor: createMonitor(), host: "0.0.0.0" })).rejects.toThrow(/loopback/);
    const { url, link } = await start();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(link).toBe(`${url}/#k=test-token-0123456789`);
  });

  it("serves the page with locked-down headers and no CORS", async () => {
    const { url } = await start();
    const page = await raw(url);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    expect(page.body).toContain('<script type="module" src="/monitor.js">');
    expect((await raw(url, { path: "/monitor.js" })).headers["content-type"]).toMatch(/javascript/);
    expect((await raw(url, { path: "/monitor.css" })).headers["content-type"]).toMatch(/text\/css/);
  });

  it("puts nothing from the log into the page itself", async () => {
    const { url } = await start();
    monitor.emit({ kind: "reply", turn: "t", attempt: 1, text: "SENSITIVE-REPLY", ms: 1 });
    expect((await raw(url)).body).not.toContain("SENSITIVE-REPLY");
  });

  it("refuses a Host that is not this listener (DNS rebinding)", async () => {
    const { url, port } = await start();
    expect((await raw(url, { headers: { Host: `evil.example:${port}` } })).status).toBe(403);
    expect((await raw(url, { headers: { Host: `127.0.0.1:${port + 1}` } })).status).toBe(403);
  });

  it("needs the key for the log", async () => {
    const { url } = await start();
    expect((await raw(url, { path: "/events" })).status).toBe(401);
    expect((await raw(url, { path: "/events", headers: { Authorization: "Bearer wrong-token-012345678" } })).status).toBe(401);
    expect((await raw(url, { method: "POST", path: "/clear" })).status).toBe(401);
  });

  it("refuses other origins, other sites and preflights", async () => {
    const { url, link } = await start();
    const auth = { Authorization: `Bearer ${keyOf(link)}` };
    expect((await raw(url, { path: "/events", headers: { ...auth, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await raw(url, { path: "/events", headers: { ...auth, "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await raw(url, { method: "OPTIONS", path: "/events", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const sameOrigin = await raw(url, { method: "POST", path: "/clear", headers: { ...auth, Origin: url, "Sec-Fetch-Site": "same-origin" } });
    expect(sameOrigin.status).toBe(204);
  });

  it("streams a hello, the snapshot, a live marker, then live events", async () => {
    const { url, link } = await start();
    monitor.emit({ kind: "check", check: "egress", verdict: "allowed", summary: "before" });
    const pending = raw(url, { path: "/events", headers: { Authorization: `Bearer ${keyOf(link)}` }, readMs: 300 });
    setTimeout(() => monitor.emit({ kind: "check", check: "egress", verdict: "denied", summary: "after" }), 100);
    const { status, headers, body } = await pending;
    expect(status).toBe(200);
    expect(headers["content-type"]).toMatch(/text\/event-stream/);
    const events = body
      .split("\n\n")
      .filter((block) => block.startsWith("data: "))
      .map((block) => JSON.parse(block.slice(6)));
    expect(events.map((event) => event.kind)).toEqual(["hello", "check", "live", "check"]);
    expect(events[1].summary).toBe("before");
    expect(events[3].summary).toBe("after");
    expect(body).toContain(": keepalive");
  });

  it("limits how many pages can stream at once", async () => {
    monitor = createMonitor();
    handle = await startMonitorServer({ monitor, token: "test-token-0123456789", maxClients: 1 });
    const auth = { Authorization: "Bearer test-token-0123456789" };
    const first = raw(handle.url, { path: "/events", headers: auth, readMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await raw(handle.url, { path: "/events", headers: auth })).status).toBe(429);
    await first;
  });

  it("clears the log on request", async () => {
    const { url, link } = await start();
    monitor.emit({ kind: "check", check: "egress", verdict: "allowed", summary: "x" });
    expect((await raw(url, { method: "GET", path: "/clear", headers: { Authorization: `Bearer ${keyOf(link)}` } })).status).toBe(405);
    expect((await raw(url, { method: "POST", path: "/clear", headers: { Authorization: `Bearer ${keyOf(link)}` } })).status).toBe(204);
    expect(monitor.size).toBe(0);
  });

  it("404s anything else", async () => {
    const { url } = await start();
    expect((await raw(url, { path: "/../../etc/passwd" })).status).toBe(404);
    expect((await raw(url, { path: "/index.html" })).status).toBe(404);
  });

  it("fails clearly when the page's files are missing", async () => {
    await expect(startMonitorServer({ monitor: createMonitor(), assetsDir: new URL("file:///nonexistent-dir/") })).rejects.toThrow(/npm run build/);
  });
});
