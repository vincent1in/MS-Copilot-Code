/**
 * The gateway with a monitor attached, end to end against the stub Copilot: what each
 * turn records, what never gets recorded, and the Work IQ policy in action.
 */

import { afterEach, describe, expect, it } from "vitest";
import { completion, disengaged, startStubCopilot, streamItem, type StubServer } from "../../test/stub-copilot.js";
import { startServer, type ProxyHandle, type ServerDeps } from "../server.js";
import type { MonitorEvent } from "./events.js";
import { createMonitor, type Monitor } from "./monitor.js";

const TOKEN_PAYLOAD_MARKER = "token-payload-that-must-never-be-recorded";

function fakeToken(): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ oid: "oid", tid: "tid", note: TOKEN_PAYLOAD_MARKER })}.sig`;
}

let stub: StubServer | undefined;
let proxy: ProxyHandle | undefined;
let monitor: Monitor;

afterEach(async () => {
  await proxy?.close();
  await stub?.close();
  proxy = undefined;
  stub = undefined;
});

async function start(respond: (chat: any) => unknown[], deps: Partial<ServerDeps> = {}, withMonitor = true) {
  stub = await startStubCopilot({ respond });
  monitor = createMonitor();
  proxy = await startServer({
    getToken: async () => fakeToken(),
    endpoint: stub.origin,
    ...(withMonitor ? { monitor } : {}),
    ...deps,
  });
  return proxy;
}

const bash = {
  type: "function" as const,
  function: { name: "bash", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
};
const read = {
  type: "function" as const,
  function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
};
const extraTools = ["glob", "list", "todowrite", "webfetch", "task", "question"].map((name) => ({
  type: "function" as const,
  function: { name, description: name, parameters: { type: "object", properties: {} } },
}));

async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await fetch(`${proxy!.url}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${proxy!.apiKey}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model: "gpt-6.1-sol", ...body }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

const of = <K extends MonitorEvent["kind"]>(kind: K) => monitor.snapshot().filter((event): event is Extract<MonitorEvent, { kind: K }> => event.kind === kind);

const enterpriseSearch = {
  type: 1,
  target: "update",
  arguments: [
    {
      messages: [
        { author: "bot", messageType: "InternalSearchQuery", messageId: "q1", text: "Searching your files", invocation: 'search_enterprise(query="release checklist")' },
      ],
    },
  ],
};
const sharepointSource = { sourceAttributions: [{ providerDisplayName: "Release checklist.docx", seeMoreUrl: "https://contoso.sharepoint.com/sites/eng/r.docx" }] };

describe("recording a turn", () => {
  it("records what opencode sent, the exact text Copilot got, its reply, and the call handed back", async () => {
    await start(() => [streamItem("```bash\nnpm test\n```"), completion()]);
    const { status, body } = await post(
      { messages: [{ role: "system", content: "Be careful." }, { role: "user", content: "Fix the test" }], tools: [bash, read, ...extraTools] },
      { "x-m365-session-id": "ses_123" },
    );
    expect(status).toBe(200);
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");

    const [request] = of("request");
    expect(request).toMatchObject({ model: "gpt-6.1-sol", session: "ses_123", total: 2, alreadySent: 0, images: 0 });
    expect(request!.messages.map((message) => [message.role, message.text])).toEqual([
      ["system", "Be careful."],
      ["user", "Fix the test"],
    ]);
    expect(request!.toolsOffered).toHaveLength(8);
    expect(request!.toolsKept).toEqual(["bash", "read"]);

    const [send] = of("send");
    const chatFrame = stub!.last().frames.find((frame) => frame.target === "chat");
    expect(send!.text).toBe(chatFrame.arguments[0].message.text);
    expect(send!.host).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(send!.path).toBe("/m365Copilot/Chathub/oid@tid");
    expect(send!.params.scenario).toBe("OfficeWebIncludedCopilot");
    expect(send!.params).not.toHaveProperty("access_token");
    expect((send!.envelope as any).message.text).toBe("(the text is shown separately)");
    expect((send!.envelope as any).tone).toBe("Gpt_61_Sol_Reasoning");

    expect(of("reply")[0]!.text).toBe("```bash\nnpm test\n```");
    expect(of("result")[0]).toMatchObject({ toolCalls: [{ name: "bash", arguments: JSON.stringify({ command: "npm test" }, null, 2) }], skippedCalls: 0 });

    const checks = of("check").map((check) => [check.check, check.verdict]);
    expect(checks).toContainEqual(["tools", "info"]);
    expect(checks).toContainEqual(["conversation", "info"]);
    expect(checks).toContainEqual(["egress", "allowed"]);
    // Every event of the turn carries the same turn id, the egress check included.
    const turnIds = new Set(monitor.snapshot().map((event) => (event as { turn?: string }).turn));
    expect(turnIds.size).toBe(1);
  });

  it("never records the access token", async () => {
    await start(() => [streamItem("done"), completion()]);
    await post({ messages: [{ role: "user", content: "hi" }] });
    const recorded = JSON.stringify(monitor.snapshot());
    expect(recorded).not.toContain(TOKEN_PAYLOAD_MARKER);
    expect(recorded).not.toContain(fakeToken().split(".")[1]!);
    expect(recorded).not.toContain("access_token");
  });

  it("flags key-like text going to Copilot, and sends it unchanged", async () => {
    await start(() => [streamItem("ok"), completion()]);
    await post({ messages: [{ role: "user", content: "here is my env:\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE" }] });
    const secrets = of("check").find((check) => check.check === "secrets");
    expect(secrets?.verdict).toBe("flagged");
    expect(of("send")[0]!.text).toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("records the follow-up after a give-up as a second attempt", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
      return calls === 1
        ? [streamItem("I can't access your files from here. Please paste them."), completion()]
        : [streamItem("```bash\nls\n```"), completion()];
    });
    await post({ messages: [{ role: "user", content: "list files" }], tools: [bash] });
    expect(of("send").map((send) => [send.attempt, send.nudge])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(of("reply")).toHaveLength(2);
    expect(of("check").some((check) => check.check === "give-up")).toBe(true);
  });

  it("records a refusal as an error, with the code opencode gets", async () => {
    await start(() => [disengaged(), completion()]);
    const { status, body } = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(status).toBe(422);
    expect(of("error")[0]).toMatchObject({ code: "m365_disengaged" });
    expect(body.error.code).toBe("m365_disengaged");
    expect(of("check").some((check) => check.check === "conversation" && /dropped/.test(check.summary))).toBe(true);
  });

  it("records a session title made locally, with no Copilot call", async () => {
    await start(() => [streamItem("unused"), completion()]);
    await post({ messages: [{ role: "user", content: "Fix the date parser" }] }, { "x-m365-request-kind": "title" });
    expect(of("title")).toHaveLength(1);
    expect(of("send")).toHaveLength(0);
    expect(stub!.connections).toHaveLength(0);
  });

  it("records a refused connection", async () => {
    stub = await startStubCopilot();
    monitor = createMonitor();
    proxy = await startServer({ getToken: async () => fakeToken(), endpoint: "wss://copilot.evil.example", monitor });
    const { status } = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(status).toBe(502);
    const denied = of("check").find((check) => check.check === "egress");
    expect(denied).toMatchObject({ verdict: "denied" });
    expect(denied!.summary).toContain("copilot.evil.example");
    expect(denied!.turn).toBe(of("request")[0]!.turn);
  });

  it("stops hearing egress decisions once the server closes", async () => {
    await start(() => [streamItem("ok"), completion()]);
    await proxy!.close();
    proxy = undefined;
    const before = monitor.size;
    const { assertEgress } = await import("../egress.js");
    assertEgress("chat", "wss://127.0.0.1:1/x");
    expect(monitor.size).toBe(before);
  });
});

describe("Work IQ", () => {
  it("holds a reply drawn from work data by default, and drops the conversation", async () => {
    let calls = 0;
    await start(() => {
      calls += 1;
      return calls === 1 ? [enterpriseSearch, streamItem("The checklist says to tag.", sharepointSource), completion()] : [streamItem("fresh"), completion()];
    });
    const first = await post({ messages: [{ role: "user", content: "What does the release checklist say?" }] }, { "x-m365-session-id": "s1" });
    expect(first.status).toBe(422);
    expect(first.body.error.code).toBe("m365_work_data_held");
    expect(JSON.stringify(first.body)).not.toContain("The checklist says to tag.");
    expect(first.body.error.message).toContain("Release checklist.docx");

    const held = of("check").find((check) => check.check === "work-data");
    expect(held?.verdict).toBe("held");
    expect(of("activity")[0]).toMatchObject({ type: "InternalSearchQuery", grounding: "work" });
    expect(of("reply")[0]!.sources).toEqual([{ host: "contoso.sharepoint.com", kind: "work", title: "Release checklist.docx" }]);

    // The next request starts a fresh Copilot conversation with the whole history.
    const second = await post({ messages: [{ role: "user", content: "What does the release checklist say?" }] }, { "x-m365-session-id": "s1" });
    expect(second.status).toBe(200);
    const [firstChat, secondChat] = stub!.connections.map((connection) => connection.frames.find((frame) => frame.target === "chat"));
    expect(secondChat.arguments[0].conversationId).not.toBe(firstChat.arguments[0].conversationId);
    expect(secondChat.arguments[0].isStartOfSession).toBe(true);
  });

  it("holds even when nobody is watching", async () => {
    await start(() => [enterpriseSearch, streamItem("From your files.", sharepointSource), completion()], {}, false);
    const { status, body } = await post({ messages: [{ role: "user", content: "q" }] });
    expect(status).toBe(422);
    expect(body.error.code).toBe("m365_work_data_held");
  });

  it("holds a streamed reply before any of it is sent", async () => {
    await start(() => [enterpriseSearch, { type: 1, target: "update", arguments: [{ writeAtCursor: "From your " }] }, streamItem("From your files.", sharepointSource), completion()]);
    const response = await fetch(`${proxy!.url}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${proxy!.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol", stream: true, messages: [{ role: "user", content: "q" }] }),
    });
    const text = await response.text();
    expect(text).not.toContain("From your");
    expect(text).toContain("m365_work_data_held");
  });

  it("lets it through and flags it under flag", async () => {
    await start(() => [enterpriseSearch, streamItem("From your files.", sharepointSource), completion()], { workIq: "flag" });
    const { status, body } = await post({ messages: [{ role: "user", content: "q" }] });
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe("From your files.");
    expect(of("check").find((check) => check.check === "work-data")?.verdict).toBe("flagged");
  });

  it("only notes it under allow", async () => {
    await start(() => [enterpriseSearch, streamItem("From your files.", sharepointSource), completion()], { workIq: "allow" });
    const { status } = await post({ messages: [{ role: "user", content: "q" }] });
    expect(status).toBe(200);
    expect(of("check").find((check) => check.check === "work-data")?.verdict).toBe("info");
  });

  it("flags but does not hold a search it cannot place", async () => {
    const vague = { ...enterpriseSearch, arguments: [{ messages: [{ author: "bot", messageType: "InternalSearchQuery", text: "Looking things up" }] }] };
    await start(() => [vague, streamItem("Answer."), completion()]);
    const { status } = await post({ messages: [{ role: "user", content: "q" }] });
    expect(status).toBe(200);
    expect(of("check").find((check) => check.check === "work-data")?.verdict).toBe("flagged");
  });

  it("says nothing when Copilot searched and cited nothing", async () => {
    await start(() => [streamItem("Plain answer."), completion()]);
    await post({ messages: [{ role: "user", content: "q" }] });
    expect(of("check").some((check) => check.check === "work-data")).toBe(false);
  });

  it("is not fooled by a work URL in the answer's own text", async () => {
    await start(() => [streamItem("Your config points at https://contoso.sharepoint.com/sites/x, which is fine."), completion()]);
    const { status } = await post({ messages: [{ role: "user", content: "review my config" }] });
    expect(status).toBe(200);
  });
});
