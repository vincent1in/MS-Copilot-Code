import { describe, expect, it } from "vitest";
import {
  applyEvent,
  countLines,
  createState,
  describeCall,
  formatDuration,
  linesLabel,
  parseBlock,
  splitBlocks,
  summarizeTurn,
} from "./ui/monitor.js";

describe("the page's stream parser", () => {
  it("splits complete blocks and keeps the unfinished rest", () => {
    expect(splitBlocks('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"')).toEqual({
      blocks: ['data: {"a":1}', 'data: {"b":2}'],
      rest: 'data: {"c"',
    });
  });

  it("reads data lines and ignores keepalive comments and junk", () => {
    expect(parseBlock('data: {"kind":"live"}')).toEqual({ kind: "live" });
    expect(parseBlock(": keepalive")).toBeUndefined();
    expect(parseBlock("data: {not json")).toBeUndefined();
  });
});

describe("the page's state", () => {
  const at = "2026-11-12T12:00:00.000Z";
  const later = "2026-11-12T12:00:01.500Z";

  it("assembles a turn from its events", () => {
    const state = createState();
    applyEvent(state, { kind: "request", turn: "t1", seq: 1, at, model: "gpt-6.1-sol", session: "ses_abcdefghijkl", total: 2, alreadySent: 0, messages: [] });
    applyEvent(state, { kind: "send", turn: "t1", seq: 2, at, attempt: 1, text: "hi" });
    applyEvent(state, { kind: "activity", turn: "t1", seq: 3, at, attempt: 1, type: "Progress", text: "…" });
    applyEvent(state, { kind: "reply", turn: "t1", seq: 4, at, attempt: 1, text: "```bash\nls\n```" });
    applyEvent(state, { kind: "result", turn: "t1", seq: 5, at: later, toolCalls: [{ name: "bash", arguments: '{"command":"npm test"}' }], text: "" });
    const turn = state.turns.get("t1");
    expect(turn.attempts).toHaveLength(1);
    expect(turn.attempts[0].activity).toHaveLength(1);
    expect(summarizeTurn(turn)).toEqual({ what: "bash: npm test", localOnly: false, flags: [], meta: ["gpt-6.1-sol", "session efghijkl", "1.5 s"] });
  });

  it("flags held and flagged turns", () => {
    const state = createState();
    applyEvent(state, { kind: "check", turn: "t1", seq: 1, at, check: "secrets", verdict: "flagged", summary: "" });
    applyEvent(state, { kind: "check", turn: "t1", seq: 2, at, check: "work-data", verdict: "held", summary: "" });
    applyEvent(state, { kind: "error", turn: "t1", seq: 3, at, code: "m365_work_data_held", message: "" });
    const summary = summarizeTurn(state.turns.get("t1"));
    expect(summary.what).toBe("Held: Copilot drew on work data");
    expect(summary.flags).toEqual([
      { label: "Key-like text", tone: "warn" },
      { label: "Held", tone: "stop" },
    ]);
  });

  it("starts over on a new snapshot or a clear", () => {
    const state = createState();
    applyEvent(state, { kind: "check", seq: 1, at, check: "egress", verdict: "allowed", summary: "" });
    applyEvent(state, { kind: "request", turn: "t1", seq: 2, at, model: "m", total: 1, alreadySent: 0, messages: [] });
    expect(applyEvent(state, { kind: "cleared", seq: 3, at })).toBe("*");
    expect(state.order).toEqual([]);
    expect(state.checks).toEqual([]);
    applyEvent(state, { kind: "request", turn: "t2", seq: 4, at, model: "m", total: 1, alreadySent: 0, messages: [] });
    expect(applyEvent(state, { kind: "hello", facts: { proxy: "x" } })).toBe("*");
    expect(state.facts).toEqual({ proxy: "x" });
    expect(state.order).toEqual([]);
  });

  it("shows a locally made title as its own row", () => {
    const state = createState();
    const id = applyEvent(state, { kind: "title", seq: 9, at, model: "m", title: "Fix date test" });
    expect(summarizeTurn(state.turns.get(id!)).localOnly).toBe(true);
  });

  it("ignores what it does not know", () => {
    const state = createState();
    expect(applyEvent(state, { kind: "mystery" })).toBeNull();
    expect(applyEvent(state, null)).toBeNull();
  });
});

describe("the page's formatting", () => {
  it("names a call by its most telling argument", () => {
    expect(describeCall({ name: "read", arguments: '{"filePath":"src/a.ts"}' })).toBe("read: src/a.ts");
    expect(describeCall({ name: "bash", arguments: '{"command":"npm test\\nnpm run lint"}' })).toBe("bash: npm test");
    expect(describeCall({ name: "todo", arguments: "not json" })).toBe("todo");
  });

  it("formats durations and line counts", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(1_840)).toBe("1.8 s");
    expect(formatDuration(75_000)).toBe("1 min 15 s");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(countLines("a\nb\nc")).toBe(3);
    expect(linesLabel(1)).toBe("1 line");
    expect(linesLabel(2)).toBe("2 lines");
  });
});
