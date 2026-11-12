/**
 * The monitor as it ships: `opencode-m365 serve --monitor` from the built bundle must
 * find its page files beside the bundle and serve them. A missing copy step in the
 * build would otherwise only show up when someone opens the link.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(repoRoot, "dist", "cli.mjs");

let child: ChildProcess | undefined;

beforeAll(() => {
  if (!existsSync(cli)) execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore", timeout: 180_000 });
}, 200_000);

afterEach(() => {
  child?.kill("SIGKILL");
  child = undefined;
});

describe("the built monitor", () => {
  it("ships only the page's own files", () => {
    expect(readdirSync(path.join(repoRoot, "dist", "ui")).sort()).toEqual(["index.html", "monitor.css", "monitor.js"]);
  });

  it("serves its page from `serve --monitor`, and leaves a private link for the CLI", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "monitor-built-"));
    child = spawn(process.execPath, [cli, "serve", "--port", "0", "--monitor"], {
      env: { ...process.env, M365_CONFIG_DIR: configDir, M365_MONITOR: "", M365_PROXY_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const link = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`no monitor link in output:\n${out}`)), 15_000);
      child!.stdout!.on("data", (chunk) => {
        out += String(chunk);
        const match = /monitor:\s+(http:\/\/127\.0\.0\.1:\d+\/#k=[A-Za-z0-9_-]+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child!.on("exit", (code) => reject(new Error(`serve exited with ${code}:\n${out}`)));
    });

    const base = link.split("#")[0]!;
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Gateway monitor");
    expect((await fetch(`${base}monitor.js`)).status).toBe(200);
    expect((await fetch(`${base}events`)).status).toBe(401);

    const links = readdirSync(path.join(configDir, "monitor"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(new RegExp(`^${child.pid}-\\d+\\.json$`));
  }, 30_000);
});
