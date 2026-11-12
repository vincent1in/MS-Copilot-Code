import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listMonitorLinks, publishMonitorLink } from "./links.js";

const entry = (pid: number, port: number) => ({
  pid,
  link: `http://127.0.0.1:${port}/#k=abcDEF_123-xyz`,
  startedAt: new Date(Date.UTC(2026, 10, 12, 12, 0, port % 60)).toISOString(),
  proxy: "http://127.0.0.1:4141",
});

describe("monitor links", () => {
  it("writes an owner-only file and removes it again", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "links-")), "monitor");
    const remove = publishMonitorLink(entry(process.pid, 5001), 5001, dir);
    const [name] = readdirSync(dir);
    expect(name).toBe(`${process.pid}-5001.json`);
    if (process.platform !== "win32") {
      expect(statSync(join(dir, name!)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(listMonitorLinks(dir)).toEqual([entry(process.pid, 5001)]);
    remove();
    remove();
    expect(existsSync(join(dir, name!))).toBe(false);
  });

  it("lists running gateways newest first and clears out the dead and the malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "links-"));
    publishMonitorLink(entry(101, 5002), 5002, dir);
    publishMonitorLink(entry(202, 5010), 5010, dir);
    publishMonitorLink(entry(303, 5005), 5005, dir);
    writeFileSync(join(dir, "404-1.json"), "{not json");
    writeFileSync(join(dir, "505-1.json"), JSON.stringify({ ...entry(505, 1), link: "https://evil.example/#k=x" }));
    writeFileSync(join(dir, "notes.txt"), "left alone");

    const alive = new Set([101, 202, 404, 505]);
    const links = listMonitorLinks(dir, (pid) => alive.has(pid));
    expect(links.map((link) => link.pid)).toEqual([202, 101]);
    expect(readdirSync(dir).sort()).toEqual(["101-5002.json", "202-5010.json", "notes.txt"]);
  });

  it("finds nothing when there is no directory yet", () => {
    expect(listMonitorLinks(join(tmpdir(), "does-not-exist-monitor-links"))).toEqual([]);
  });
});
