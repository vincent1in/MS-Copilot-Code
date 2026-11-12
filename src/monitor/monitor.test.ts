import { describe, expect, it } from "vitest";
import type { MonitorEvent } from "./events.js";
import { createMonitor } from "./monitor.js";

const check = (summary: string, detail?: unknown) => ({ kind: "check" as const, check: "egress" as const, verdict: "allowed" as const, summary, ...(detail !== undefined ? { detail } : {}) });

describe("createMonitor", () => {
  it("numbers and timestamps events, oldest first", () => {
    const monitor = createMonitor({ now: () => new Date("2026-11-12T12:00:00.000Z") });
    monitor.emit(check("one"));
    monitor.emit(check("two"));
    const events = monitor.snapshot();
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[0]!.at).toBe("2026-11-12T12:00:00.000Z");
  });

  it("keeps conversation content verbatim, credential-shaped or not", () => {
    const monitor = createMonitor();
    const text = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and eyJhbGciOiJub25lIn0.eyJvaWQiOiJ4In0.c2ln";
    monitor.emit({ kind: "send", turn: "t", attempt: 1, nudge: false, host: "substrate.office.com", path: "/p", params: {}, text, envelope: {} });
    expect((monitor.snapshot()[0] as Extract<MonitorEvent, { kind: "send" }>).text).toBe(text);
  });

  it("redacts the gateway's own plumbing fields, as the log does", () => {
    const monitor = createMonitor();
    monitor.emit(check("wss://substrate.office.com/x?access_token=SECRET123&a=b", { url: "https://h/?access_token=SECRET456" }));
    monitor.emit({ kind: "send", turn: "t", attempt: 1, nudge: false, host: "h", path: "/p", params: { access_token: "x", ok: "Bearer abcdefghijklmnopqrstuvwxyz" }, text: "", envelope: { auth: "Bearer abcdefghijklmnopqrstuvwxyz" } });
    monitor.emit({ kind: "error", turn: "t", code: "upstream_error", message: "connect failed: wss://h/?access_token=SECRET789" });
    const recorded = JSON.stringify(monitor.snapshot());
    for (const secret of ["SECRET123", "SECRET456", "SECRET789", "abcdefghijklmnopqrstuvwxyz"]) expect(recorded).not.toContain(secret);
  });

  it("copies what it records, so later changes by the caller cannot alter it", () => {
    const monitor = createMonitor();
    const detail = { hosts: ["a"] };
    monitor.emit(check("x", detail));
    detail.hosts.push("b");
    expect((monitor.snapshot()[0] as Extract<MonitorEvent, { kind: "check" }>).detail).toEqual({ hosts: ["a"] });
  });

  it("cuts a long string and says so", () => {
    const monitor = createMonitor({ maxFieldChars: 10 });
    monitor.emit({ kind: "reply", turn: "t", attempt: 1, text: "0123456789ABCDEF", ms: 1 });
    const text = (monitor.snapshot()[0] as Extract<MonitorEvent, { kind: "reply" }>).text;
    expect(text.startsWith("0123456789\n")).toBe(true);
    expect(text).toContain("kept the first 10 of 16 characters");
  });

  it("drops the oldest events past the count limit", () => {
    const monitor = createMonitor({ maxEvents: 3 });
    for (const summary of ["a", "b", "c", "d", "e"]) monitor.emit(check(summary));
    expect(monitor.snapshot().map((event) => (event as Extract<MonitorEvent, { kind: "check" }>).summary)).toEqual(["c", "d", "e"]);
  });

  it("drops the oldest events past the size limit, but always keeps the newest", () => {
    const monitor = createMonitor({ maxChars: 1_000, maxFieldChars: 5_000 });
    monitor.emit({ kind: "reply", turn: "t", attempt: 1, text: "x".repeat(600), ms: 1 });
    monitor.emit({ kind: "reply", turn: "t", attempt: 2, text: "y".repeat(600), ms: 1 });
    expect(monitor.snapshot().map((event) => (event as Extract<MonitorEvent, { kind: "reply" }>).attempt)).toEqual([2]);
    monitor.emit({ kind: "reply", turn: "t", attempt: 3, text: "z".repeat(4_000), ms: 1 });
    expect(monitor.snapshot().map((event) => (event as Extract<MonitorEvent, { kind: "reply" }>).attempt)).toEqual([3]);
  });

  it("streams live events to subscribers until they unsubscribe", () => {
    const monitor = createMonitor();
    const seen: string[] = [];
    const stop = monitor.subscribe((event) => seen.push(event.kind));
    monitor.emit(check("a"));
    stop();
    monitor.emit(check("b"));
    expect(seen).toEqual(["check"]);
  });

  it("keeps going when a subscriber throws", () => {
    const monitor = createMonitor();
    const seen: number[] = [];
    monitor.subscribe(() => {
      throw new Error("broken viewer");
    });
    monitor.subscribe((event) => seen.push(event.seq));
    expect(() => monitor.emit(check("a"))).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it("clears everything and tells subscribers", () => {
    const monitor = createMonitor();
    const seen: string[] = [];
    monitor.emit(check("a"));
    monitor.subscribe((event) => seen.push(event.kind));
    monitor.clear();
    expect(monitor.snapshot()).toEqual([]);
    expect(monitor.size).toBe(0);
    expect(seen).toEqual(["cleared"]);
  });

  it("never throws into the gateway, whatever it is given", () => {
    const monitor = createMonitor();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => monitor.emit(check("cyclic", cyclic))).not.toThrow();
    const recorded = monitor.snapshot()[0] as Extract<MonitorEvent, { kind: "check" }>;
    expect(JSON.stringify(recorded.detail)).toContain("nested too deeply");
  });
});
