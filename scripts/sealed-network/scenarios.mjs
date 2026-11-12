// The everyday paths, driven the way a person and OpenCode would, inside the sealed
// network. Each step is timestamped so the sink's log can be split by step.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [gateway, outDir, which] = process.argv.slice(2);
const marks = join(outDir, "steps.jsonl");
const mark = (step, phase) => appendFileSync(marks, JSON.stringify({ step, phase, t: Date.now() / 1000 }) + "\n");
const fresh = (name) => {
  const home = mkdtempSync(join(tmpdir(), `scenario-${name}-`));
  mkdirSync(join(home, ".config", "opencode-copilot"), { recursive: true, mode: 0o700 });
  return home;
};
const env = (home, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: home,
  M365_CONFIG_DIR: join(home, ".config", "opencode-copilot"),
  M365_OPENCODE_CONFIG: join(home, ".config", "opencode", "opencode.json"),
  NODE_OPTIONS: `--require ${gateway}/scripts/net-guard.cjs`,
  NET_GUARD_LOG: join(outDir, `net-guard-${which}.jsonl`),
  ...extra,
});
const run = (args, e, ms = 60000) =>
  new Promise((resolve) => {
    const child = spawn("node", [`${gateway}/dist/cli.mjs`, ...args], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    child.on("exit", () => (clearTimeout(timer), resolve(out)));
  });
const startGateway = (e, port) =>
  new Promise((resolve, reject) => {
    const child = spawn("node", [`${gateway}/dist/cli.mjs`, "start", "--no-open", "--port", String(port)], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const onData = (d) => {
      out += d;
      const link = /http:\/\/127\.0\.0\.1:(\d+)\/#k=([\w-]+)/.exec(out);
      if (link) resolve({ child, origin: `http://127.0.0.1:${link[1]}`, key: link[2], port: Number(link[1]) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    setTimeout(() => reject(new Error("gateway did not start: " + out)), 20000);
  });
const page = (g) => {
  const headers = { Authorization: `Bearer ${g.key}`, Origin: g.origin, "Sec-Fetch-Site": "same-origin" };
  return {
    get: async (path) => (await fetch(g.origin + path, { headers })).json(),
    post: async (path, body) => {
      const r = await fetch(g.origin + path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
};
const report = (line) => appendFileSync(join(outDir, "report.txt"), line + "\n");

async function notSignedIn() {
  const home = fresh("a");
  const e = env(home);
  mark("A1 help, doctor, setup", "start");
  await run(["help"], e);
  await run(["doctor"], e);
  await run(["setup", "--quiet"], e);
  mark("A1 help, doctor, setup", "end");

  mark("A2 page: state, settings, Connect, test message", "start");
  const g = await startGateway(e, 4141);
  const p = page(g);
  const state = await p.get("/api/state");
  await p.post("/api/settings", { key: "workIq", value: "flag" });
  await p.post("/api/settings", { key: "workIq", value: "hold" });
  const connected = await p.post("/api/connect-opencode", { quiet: true });
  const test = await p.post("/api/test", { model: "gpt-6.1-sol" });
  report(`A2: account=${state.account ?? "none"} connect=${connected.status} connected=${connected.body?.opencode?.connected} test=${test.body?.ok === false ? "refused locally: " + test.body.error.slice(0, 60) : JSON.stringify(test.body).slice(0, 80)}`);
  writeFileSync(join(outDir, "listening-A2.txt"), "");
  await new Promise((r) => setTimeout(r, 8000)); // window for the inbound probe from the sink
  g.child.kill("SIGTERM");
  mark("A2 page: state, settings, Connect, test message", "end");
}

async function insideOpenCode() {
  const home = fresh("b");
  mark("B inside OpenCode: plugin, models, page", "start");
  const e = env(home, { M365_MONITOR: "1" });
  const script = `
    const plugin = (await import(${JSON.stringify(gateway + "/dist/plugin.mjs")})).default;
    const added = [];
    const reg = { dispose: async () => {} };
    const ctx = { options: {}, provider: { transform: async (cb) => (cb({ add: (x) => added.push(x) }), reg) },
      model: { transform: async (cb) => (cb({ default: { get: () => undefined, set: () => {} } }), reg) },
      session: { hook: async () => reg } };
    const close = await plugin.setup(ctx);
    const { info, models } = added[0];
    const base = info.settings.baseURL, key = info.settings.apiKey;
    const list = await (await fetch(base + "/models", { headers: { Authorization: "Bearer " + key } })).json();
    const chat = await fetch(base + "/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "hi" }] }) });
    console.log("B: provider " + info.id + " at " + base + ", " + models.length + " models, /models lists " + list.data.length + ", chat without sign-in -> HTTP " + chat.status);
    await new Promise((r) => setTimeout(r, 8000));
    await close();
  `;
  const out = await new Promise((resolve) => {
    const child = spawn("node", ["--input-type=module", "-e", script], { env: e, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.on("exit", () => resolve(text));
  });
  report(out.split("\n").filter((l) => l.startsWith("B:")).join("\n"));
  mark("B inside OpenCode: plugin, models, page", "end");
}

async function signedIn(kind, step) {
  const home = fresh(kind);
  cpSync(join(outDir, `cache-${kind}.json`), join(home, ".config", "opencode-copilot", "msal-cache.json"));
  const e = env(home);
  mark(step, "start");
  const g = await startGateway(e, 4141);
  const p = page(g);
  const state = await p.get("/api/state");
  const test = await p.post("/api/test", { model: "gpt-6.1-sol" });
  report(`${step.split(" ")[0]}: account=${state.account} test ok=${test.body?.ok} error=${(test.body?.error ?? "").slice(0, 90)}`);
  g.child.kill("SIGTERM");
  mark(step, "end");
}

async function signInWindow() {
  const home = fresh("e");
  mark("E sign-in window (Chrome)", "start");
  const out = await run(["login"], env(home, { CHROMIUM_PATH: process.env.CHROMIUM_PATH || "/usr/bin/google-chrome", DISPLAY: process.env.DISPLAY ?? "", XAUTHORITY: process.env.XAUTHORITY ?? "" }), 45000);
  report(`E: the sign-in window was open 45 s, then closed: ${out.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 100) ?? "(no output)"}`);
  mark("E sign-in window (Chrome)", "end");
}

const steps = { notSignedIn, insideOpenCode, valid: () => signedIn("valid", "C signed in: test message with a valid token"), expired: () => signedIn("expired", "D signed in: test message with an expired token"), signInWindow };
await steps[which]();
