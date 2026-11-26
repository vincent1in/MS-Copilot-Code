import { describe, expect, it } from "vitest";
import {
  METRICS_RPC,
  SessionMetricsStore,
  allowanceLabel,
  describeAllowances,
  metricsRpcHandlers,
  remoteMetrics,
} from "./metrics.js";
import { resolveModel } from "./models.js";

const at = new Date("2026-11-19T12:00:00Z");

describe("describeAllowances", () => {
  it("pairs each budget's daily and weekly keys under a friendly name", () => {
    const budgets = describeAllowances({ GPT61SolQueryDaily: 31, GPT61SolQueryWeekly: 70 });
    expect(budgets).toEqual([
      { name: "GPT-6.1 Sol", model: "gpt-6.1-sol", daily: { remaining: 31, limit: 40 }, weekly: { remaining: 70, limit: 75 } },
    ]);
  });

  it("knows GPT-6.1 Sol and GPT-6.2 Sol, and drops the budgets of upstream's paid models", () => {
    const budgets = describeAllowances({
      ClaudeOpusQueryDaily: 31,
      ClaudeSonnet55QueryDaily: 79,
      GPT61SolQueryDaily: 34,
      GPT61SolQueryWeekly: 69,
      GPT62SolQueryDaily: 12,
      GPT62AstraQueryWeekly: 5,
    });
    expect(budgets.map((budget) => budget.name)).toEqual(["GPT-6.1 Sol", "GPT-6.2 Sol"]);
    // No measured cap for GPT-6.2: the remaining count stands alone.
    expect(budgets[1]).toEqual({ name: "GPT-6.2 Sol", model: "gpt-6.2-sol", daily: { remaining: 12 } });
  });

  it("drops the keys it has no name for (DeepResearch, the Word and Dev variants)", () => {
    expect(describeAllowances({ DeepResearch: 100, ClaudeOpusQueryDailyWord: 40, ClaudeOpusQueryDev: 5 })).toEqual([]);
  });

  it("maps every budget to a model the catalogue lists", () => {
    const all = describeAllowances({ GPT61SolQueryDaily: 1, GPT62SolQueryDaily: 1 });
    expect(all).toHaveLength(2);
    for (const budget of all) expect(resolveModel(budget.model).id).toBe(budget.model);
  });
});

describe("allowanceLabel", () => {
  it("reads as remaining out of the cap, today and this week", () => {
    expect(allowanceLabel(describeAllowances({ GPT61SolQueryDaily: 31, GPT61SolQueryWeekly: 70 })[0]!)).toBe(
      "GPT-6.1 Sol: 31/40 left today, 70/75 left this week",
    );
  });

  it("says what is left when the cap is unknown, and leaves out a missing window", () => {
    expect(allowanceLabel({ name: "GPT-6.2 Sol", model: "gpt-6.2-sol", daily: { remaining: 12 } })).toBe(
      "GPT-6.2 Sol: 12 left today",
    );
  });
});

describe("SessionMetricsStore", () => {
  const sol = resolveModel("gpt-6.1-sol");
  // No listed model bills credits; the count is still kept, should one ever be listed.
  const billed = { ...resolveModel("gpt-6.2-sol"), id: "billed-for-test", credits: true };

  it("knows nothing about a session it has not seen", () => {
    expect(new SessionMetricsStore().get("ses_unknown")).toBeUndefined();
  });

  it("records a turn: model, conversation quota, context tokens and the turn count", () => {
    const store = new SessionMetricsStore();
    store.recordTurn("ses_1", { model: sol, throttle: { current: 12, max: 600 }, contextTokens: 3400, now: at });
    store.recordTurn("ses_1", { model: sol, throttle: { current: 13, max: 600 }, contextTokens: 3900, now: at });
    expect(store.get("ses_1")).toEqual({
      sessionID: "ses_1",
      model: { id: "gpt-6.1-sol", name: sol.name },
      conversation: { used: 13, max: 600 },
      contextTokens: 3900,
      turns: 2,
      creditTurns: 0,
    });
  });

  it("counts the turns on a credit-billed model, not an amount", () => {
    const store = new SessionMetricsStore();
    store.recordTurn("ses_1", { model: billed, now: at });
    store.recordTurn("ses_1", { model: sol, now: at });
    store.recordTurn("ses_1", { model: billed, now: at });
    expect(store.get("ses_1")).toMatchObject({ turns: 3, creditTurns: 2, model: { id: "billed-for-test" } });
  });

  it("keeps the last metering snapshot with when it was read, and keeps it over a turn with none", () => {
    const store = new SessionMetricsStore();
    store.recordTurn("ses_1", { model: sol, metering: { GPT61SolQueryDaily: 31, GPT61SolQueryWeekly: 70 }, now: at });
    store.recordTurn("ses_1", { model: resolveModel("gpt-6.2-sol"), now: new Date("2026-11-19T12:05:00Z") });
    expect(store.get("ses_1")?.allowances).toEqual({
      readAt: "2026-11-19T12:00:00.000Z",
      budgets: [
        { name: "GPT-6.1 Sol", model: "gpt-6.1-sol", daily: { remaining: 31, limit: 40 }, weekly: { remaining: 70, limit: 75 } },
      ],
      labels: ["GPT-6.1 Sol: 31/40 left today, 70/75 left this week"],
    });
  });

  it("keeps the last refusal, and a later answered turn clears it", () => {
    const store = new SessionMetricsStore();
    store.recordRefusal("ses_1", { model: sol, reason: "allowance", message: "daily allowance used up", now: at });
    expect(store.get("ses_1")).toMatchObject({
      turns: 0,
      model: { id: "gpt-6.1-sol" },
      lastRefusal: { reason: "allowance", message: "daily allowance used up", at: "2026-11-19T12:00:00.000Z" },
    });
    store.recordTurn("ses_1", { model: resolveModel("gpt-6.2-sol"), now: at });
    expect(store.get("ses_1")?.lastRefusal).toBeUndefined();
  });

  it("forgets the least recently used session past its capacity", () => {
    const store = new SessionMetricsStore(3);
    for (const id of ["a", "b", "c"]) store.recordTurn(id, { model: sol, now: at });
    store.get("a"); // reading counts as use
    store.recordTurn("d", { model: sol, now: at });
    expect(store.get("b")).toBeUndefined();
    expect(["a", "c", "d"].map((id) => store.get(id)?.sessionID)).toEqual(["a", "c", "d"]);
  });

  it("holds about 200 sessions by default", () => {
    const store = new SessionMetricsStore();
    for (let i = 0; i < 201; i++) store.recordTurn(`ses_${i}`, { model: sol, now: at });
    expect(store.get("ses_0")).toBeUndefined();
    expect(store.get("ses_200")).toBeDefined();
    expect(store.size).toBe(200);
  });

  it("tells a listener which session changed", () => {
    const store = new SessionMetricsStore();
    const changed: string[] = [];
    store.onChange((sessionID) => changed.push(sessionID));
    store.recordTurn("ses_1", { model: sol, now: at });
    store.recordRefusal("ses_2", { model: sol, reason: "licence", message: "no premium licence", now: at });
    expect(changed).toEqual(["ses_1", "ses_2"]);
  });

  it("hands out copies, so a caller cannot edit the store", () => {
    const store = new SessionMetricsStore();
    store.recordTurn("ses_1", { model: sol, now: at });
    store.get("ses_1")!.turns = 99;
    expect(store.get("ses_1")?.turns).toBe(1);
  });
});

describe("the metrics RPC", () => {
  it("is a portable definition: an id, JSON-schema methods and an event", () => {
    expect(METRICS_RPC.id).toBe("m365-copilot.metrics");
    expect(METRICS_RPC.methods.get.input).toMatchObject({ type: "object", required: ["sessionID"] });
    expect(METRICS_RPC.methods.get.output).toMatchObject({ type: "object" });
    expect(METRICS_RPC.events.updated.schema).toMatchObject({ type: "object" });
    expect(JSON.parse(JSON.stringify(METRICS_RPC))).toEqual(METRICS_RPC);
  });

  it("answers a session's metrics from the store", async () => {
    const store = new SessionMetricsStore();
    store.recordTurn("ses_1", { model: resolveModel("gpt-6.2-sol"), throttle: { current: 4, max: 600 }, now: at });
    const handlers = metricsRpcHandlers(() => store);
    const answer = await handlers.get({ sessionID: "ses_1" });
    expect(answer.metrics).toMatchObject({ sessionID: "ses_1", conversation: { used: 4, max: 600 } });
  });

  it("answers null for an unknown session, or when this process runs no proxy", async () => {
    const store = new SessionMetricsStore();
    expect((await metricsRpcHandlers(() => store).get({ sessionID: "nope" })).metrics).toBeNull();
    expect((await metricsRpcHandlers(() => undefined).get({ sessionID: "ses_1" })).metrics).toBeNull();
  });

  it("answers null to an input without a session id rather than throwing", async () => {
    const handlers = metricsRpcHandlers(() => new SessionMetricsStore());
    expect((await handlers.get(undefined)).metrics).toBeNull();
    expect((await handlers.get({ sessionID: 4 })).metrics).toBeNull();
  });
});

describe("an external proxy's metrics", () => {
  const sample = { sessionID: "ses/1", model: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol" }, turns: 2, creditTurns: 0 };

  it("are read over HTTP with the proxy secret, the session id encoded", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const source = remoteMetrics("http://127.0.0.1:4141/v1", "secret", async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ metrics: sample }), { status: 200 });
    });
    expect(await source.get("ses/1")).toEqual(sample);
    expect(calls).toEqual([{ url: "http://127.0.0.1:4141/v1/m365/metrics/ses%2F1", auth: "Bearer secret" }]);
  });

  it("read as null when the proxy refuses, answers garbage, or is not there", async () => {
    expect(await remoteMetrics("http://x/v1", "k", async () => new Response("no", { status: 401 })).get("s")).toBeNull();
    expect(await remoteMetrics("http://x/v1", "k", async () => new Response("not json", { status: 200 })).get("s")).toBeNull();
    expect(
      await remoteMetrics("http://x/v1", "k", async () => {
        throw new Error("ECONNREFUSED");
      }).get("s"),
    ).toBeNull();
  });

  it("serve the RPC like the in-process store does", async () => {
    const source = remoteMetrics("http://x/v1", "k", async () => new Response(JSON.stringify({ metrics: sample })));
    expect((await metricsRpcHandlers(() => source).get({ sessionID: "ses/1" })).metrics).toEqual(sample);
  });
});
