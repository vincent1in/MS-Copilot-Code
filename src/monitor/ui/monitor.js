/*
 * Gateway monitor page. Plain JavaScript with no dependencies and nothing loaded from
 * anywhere but the gateway itself.
 *
 * Everything shown here came from opencode, from Copilot, or from files the agent
 * read, so all of it is untrusted text: it only ever reaches the page through
 * textContent and text nodes, never as HTML. (The page's content security policy
 * would stop a script from running anyway; this makes sure markup never renders.)
 *
 * The page's key arrives in the link's fragment (#k=…), which browsers do not send
 * to servers. It is moved into this tab's session storage — so a reload still works
 * and closing the tab forgets it — and taken out of the address bar.
 */

// --- pure helpers (unit-tested in monitor-ui.test.ts) --------------------------------

/** Split a text/event-stream buffer into complete blocks and the unfinished rest. */
export function splitBlocks(buffer) {
  const blocks = [];
  let start = 0;
  for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n", start)) {
    blocks.push(buffer.slice(start, end));
    start = end + 2;
  }
  return { blocks, rest: buffer.slice(start) };
}

/** The JSON payload of one block, or undefined for a comment or a malformed one. */
export function parseBlock(block) {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function createState() {
  return { facts: null, limits: null, turns: new Map(), order: [], checks: [] };
}

function resetTurns(state) {
  state.turns.clear();
  state.order.length = 0;
  state.checks.length = 0;
}

function turnFor(state, id, at) {
  let turn = state.turns.get(id);
  if (!turn) {
    turn = { id, at, lastAt: at, kind: "turn", request: null, attempts: [], result: null, error: null, checks: [], title: null };
    state.turns.set(id, turn);
    state.order.push(id);
  }
  return turn;
}

function attemptOf(turn, n) {
  const index = Math.max(1, Number(n) || 1);
  while (turn.attempts.length < index) turn.attempts.push({ n: turn.attempts.length + 1, send: null, activity: [], reply: null });
  return turn.attempts[index - 1];
}

/**
 * Fold one event into the state. Returns what changed: "*" for everything, a turn id,
 * "checks" for a check with no turn, or null for nothing visible.
 */
export function applyEvent(state, event) {
  if (!event || typeof event !== "object") return null;
  switch (event.kind) {
    case "hello":
      state.facts = event.facts ?? null;
      state.limits = event.limits ?? null;
      resetTurns(state);
      return "*";
    case "cleared":
      resetTurns(state);
      return "*";
    case "live":
      return null;
    case "title": {
      const id = `title-${event.seq}`;
      const turn = turnFor(state, id, event.at);
      turn.kind = "title";
      turn.title = event;
      return id;
    }
    case "check":
      state.checks.push(event);
      if (!event.turn) return "checks";
      turnFor(state, event.turn, event.at).checks.push(event);
      break;
    case "request":
      turnFor(state, event.turn, event.at).request = event;
      break;
    case "send":
      attemptOf(turnFor(state, event.turn, event.at), event.attempt).send = event;
      break;
    case "activity":
      attemptOf(turnFor(state, event.turn, event.at), event.attempt).activity.push(event);
      break;
    case "reply":
      attemptOf(turnFor(state, event.turn, event.at), event.attempt).reply = event;
      break;
    case "result":
      turnFor(state, event.turn, event.at).result = event;
      break;
    case "error":
      turnFor(state, event.turn, event.at).error = event;
      break;
    default:
      return null;
  }
  const turn = state.turns.get(event.turn);
  if (turn) turn.lastAt = event.at;
  return event.turn;
}

const ERROR_LABELS = {
  m365_work_data_held: "Held: Copilot drew on work data",
  m365_disengaged: "Copilot disengaged",
  m365_throttled: "Throttled by Microsoft",
  m365_not_served: "Copilot did not serve this model",
  m365_turn_rejected: "Copilot rejected the turn",
  authentication_required: "Sign-in needed",
  cancelled: "Cancelled by opencode",
  upstream_error: "Connection to Copilot failed",
};

/** The one line that names a tool call: the command, the file, the pattern. */
export function describeCall(call) {
  let args = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    /* shown raw in the detail */
  }
  const pick = ["command", "cmd", "filePath", "file_path", "path", "pattern", "query"].map((key) => args[key]).find((value) => typeof value === "string");
  const first = pick ?? Object.values(args).find((value) => typeof value === "string") ?? "";
  const line = String(first).split("\n")[0].trim();
  return line ? `${call.name}: ${line.length > 80 ? `${line.slice(0, 77)}…` : line}` : call.name;
}

/** What a turn amounts to, for its row in the list. */
export function summarizeTurn(turn) {
  if (turn.kind === "title") {
    return { what: "Session title, made locally", localOnly: true, flags: [], meta: ["No Copilot call"] };
  }
  let what = "Waiting for Copilot…";
  if (turn.error) what = ERROR_LABELS[turn.error.code] ?? `Failed: ${turn.error.code}`;
  else if (turn.result?.toolCalls?.length) what = describeCall(turn.result.toolCalls[0]);
  else if (turn.result) {
    const line = (turn.result.text || "").trim().split("\n")[0] || "(empty reply)";
    what = `Replied: ${line.length > 70 ? `${line.slice(0, 67)}…` : line}`;
  }

  const flags = [];
  const seen = new Set();
  for (const check of turn.checks) {
    const flag = flagFor(check);
    if (flag && !seen.has(flag.label)) {
      seen.add(flag.label);
      flags.push(flag);
    }
  }

  const meta = [];
  if (turn.request) meta.push(turn.request.model);
  if (turn.request?.session) meta.push(`session ${shortId(turn.request.session)}`);
  const end = turn.result || turn.error ? turn.lastAt : null;
  if (end && turn.request) meta.push(formatDuration(Date.parse(end) - Date.parse(turn.request.at)));
  if (turn.attempts.length > 1) meta.push("asked twice");
  return { what, localOnly: false, flags, meta };
}

function flagFor(check) {
  if (check.verdict === "held") return { label: "Held", tone: "stop" };
  if (check.verdict === "denied") return { label: "Refused", tone: "stop" };
  if (check.verdict !== "flagged") return null;
  if (check.check === "secrets") return { label: "Key-like text", tone: "warn" };
  if (check.check === "work-data") return { label: "Searched", tone: "warn" };
  return { label: "Flagged", tone: "warn" };
}

export function shortId(id) {
  const text = String(id ?? "");
  return text.length > 10 ? text.slice(-8) : text;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "1 line", "48 lines". */
export function linesLabel(count) {
  return `${count.toLocaleString()} ${count === 1 ? "line" : "lines"}`;
}

export function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines += 1;
  return lines;
}

// --- the page ---------------------------------------------------------------------------

const CHECK_LABELS = {
  egress: "Outbound connection",
  "work-data": "Work data (Work IQ)",
  secrets: "Key-like text",
  "give-up": "Give-up retry",
  tools: "Tool list",
  refusal: "Refusal",
  conversation: "Conversation",
};

const VERDICT_WORDS = { allowed: "Allowed", denied: "Refused", held: "Held", flagged: "Flagged", info: "Noted" };

const ACTIVITY_LABELS = {
  InternalSearchQuery: "Searched",
  InternalSearchResult: "Search results",
  Progress: "Progress note",
  RenderCardRequest: "Card",
  ReferencesListComplete: "References",
  GeneratedCode: "Generated code",
  Suggestion: "Suggested follow-up",
};

const GROUNDING_WORDS = { work: "Work data", web: "Web", unknown: "Unplaced" };

const ROLE_LABELS = { system: "System prompt", developer: "Developer instructions", user: "You", assistant: "Assistant (replayed)", tool: "Tool result" };

/** Payloads longer than this are clipped until asked for. */
const CLIP_LINES = 40;
const CLIP_CHARS = 8000;

function h(tag, attrs, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

function boot() {
  const state = createState();
  const ui = {
    linkState: document.getElementById("link-state"),
    facts: document.getElementById("facts"),
    follow: document.getElementById("follow"),
    pause: document.getElementById("pause"),
    clear: document.getElementById("clear"),
    list: document.getElementById("turn-list"),
    turn: document.getElementById("turn"),
    viewTurns: document.getElementById("view-turns"),
    viewChecks: document.getElementById("view-checks"),
    turnsView: document.getElementById("turns-view"),
    checksView: document.getElementById("checks-view"),
    checkRows: document.getElementById("check-rows"),
  };
  const view = { selected: null, follow: true, paused: false, queue: [], arrived: new Set(), expanded: new Set(), collapsed: new Set() };
  const dirty = { all: true, turns: new Set(), checks: true, facts: true };
  let frame = 0;

  const token = takeToken();
  if (!token) {
    setLinkState("refused", "This page needs its key. Open it from the link that `opencode-m365 monitor` prints.");
    render();
    return;
  }

  ui.follow.addEventListener("change", () => {
    view.follow = ui.follow.checked;
    if (view.follow && state.order.length > 0) select(state.order[state.order.length - 1]);
  });
  ui.pause.addEventListener("click", () => {
    view.paused = !view.paused;
    ui.pause.setAttribute("aria-pressed", String(view.paused));
    ui.pause.textContent = view.paused ? "Resume" : "Pause";
    if (!view.paused) {
      for (const event of view.queue.splice(0)) take(event);
      setLinkState("live", "Live");
    } else {
      setLinkState("paused", "Paused");
    }
  });
  ui.clear.addEventListener("click", async () => {
    ui.clear.disabled = true;
    try {
      const response = await fetch("/clear", { method: "POST", headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) setLinkState("stopped", "Clear failed: the gateway refused it.");
    } catch {
      setLinkState("stopped", "Clear failed: the gateway is not answering.");
    } finally {
      ui.clear.disabled = false;
    }
  });
  ui.viewTurns.addEventListener("click", () => showView("turns"));
  ui.viewChecks.addEventListener("click", () => showView("checks"));
  ui.list.addEventListener("keydown", (event) => {
    const ids = state.order;
    if (ids.length === 0) return;
    const at = Math.max(0, ids.indexOf(view.selected));
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: ids.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const id = ids[Math.min(ids.length - 1, Math.max(0, next))];
    setFollow(id === ids[ids.length - 1]);
    select(id);
  });

  connect();

  // --- stream ---

  async function connect() {
    let delay = 1000;
    for (;;) {
      try {
        setLinkState("connecting", "Connecting…");
        const response = await fetch("/events", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (response.status === 401) {
          forgetToken();
          setLinkState("refused", "The key in this link is not the gateway's. It changes every launch: run `opencode-m365 monitor` for the current link.");
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        delay = 1000;
        setLinkState(view.paused ? "paused" : "live", view.paused ? "Paused" : "Live");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          const { blocks, rest } = splitBlocks(buffer);
          buffer = rest;
          for (const block of blocks) {
            const event = parseBlock(block);
            if (event) receive(event);
          }
        }
        setLinkState("stopped", "The gateway closed the connection. Reconnecting…");
      } catch {
        setLinkState("stopped", "The gateway is not answering. It may have stopped; reconnecting…");
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }

  function receive(event) {
    // A fresh snapshot and a clear always apply, even when paused.
    if (view.paused && event.kind !== "hello" && event.kind !== "cleared") {
      view.queue.push(event);
      setLinkState("paused", `Paused, ${view.queue.length} new`);
      return;
    }
    if (event.kind === "hello" || event.kind === "cleared") view.queue.length = 0;
    take(event);
  }

  function take(event) {
    const changed = applyEvent(state, event);
    if (changed === null) return;
    if (changed === "*") {
      // A reconnect replays the snapshot under the same ids, so the selection is kept;
      // a turn that is gone (after Clear) simply shows the empty state.
      dirty.all = true;
    } else if (changed === "checks") {
      dirty.checks = true;
    } else {
      dirty.turns.add(changed);
      dirty.checks = true;
      if (event.kind === "request" || event.kind === "title") {
        view.arrived.add(changed);
        if (view.follow) view.selected = changed;
      }
    }
    if (event.kind === "hello") dirty.facts = true;
    schedule();
  }

  // --- rendering ---

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  }

  function render() {
    if (dirty.facts) renderFacts();
    renderList();
    if (dirty.all || dirty.turns.has(view.selected)) renderTurn();
    if (dirty.all || dirty.checks) renderChecks();
    dirty.all = false;
    dirty.turns.clear();
    dirty.checks = false;
    dirty.facts = false;
  }

  function renderFacts() {
    const facts = state.facts;
    ui.facts.replaceChildren();
    if (!facts) return;
    const pair = (label, value) => h("div", null, h("dt", null, label), h("dd", null, value));
    ui.facts.append(
      pair("Proxy", facts.proxy.replace(/^https?:\/\//, "")),
      pair("Default model", facts.defaultModel),
      pair("Work data", { hold: "Held", flag: "Flagged", allow: "Allowed" }[facts.workIq] ?? facts.workIq),
      pair("Bing web search", facts.webSearch ? "On" : "Off"),
      pair("Copilot Studio agent", facts.studioAgent ? "On" : "Off"),
      pair("Tool trimming", facts.lean ? "On" : "Off"),
      pair("Gateway process", String(facts.pid)),
    );
  }

  function renderList() {
    const rows = state.order.map((id) => {
      const turn = state.turns.get(id);
      const summary = summarizeTurn(turn);
      const row = h(
        "li",
        {
          class: `turn-row${view.arrived.has(id) ? " arrived" : ""}`,
          "aria-selected": String(id === view.selected),
          onclick: () => {
            setFollow(id === state.order[state.order.length - 1]);
            select(id);
          },
        },
        h("span", { class: `row-what${summary.localOnly ? " local-only" : ""}`, title: summary.what }, summary.what),
        h("span", { class: "row-flags" }, summary.flags.slice(0, 2).map((flag) => h("span", { class: `flag ${flag.tone}` }, flag.label))),
        h("span", { class: "row-meta" }, [formatTime(turn.at), ...summary.meta].map((part) => h("span", null, part))),
      );
      return row;
    });
    view.arrived.clear();
    ui.list.replaceChildren(...rows);
    const selected = ui.list.querySelector('[aria-selected="true"]');
    if (selected && view.follow) selected.scrollIntoView({ block: "nearest" });
  }

  function renderChecks() {
    const rows = [...state.checks].reverse().map((check) =>
      h(
        "tr",
        null,
        h("td", null, formatTime(check.at)),
        h("td", null, CHECK_LABELS[check.check] ?? check.check),
        h("td", null, h("span", { class: `verdict ${check.verdict}` }, VERDICT_WORDS[check.verdict] ?? check.verdict)),
        h(
          "td",
          null,
          check.summary,
          check.turn && state.turns.has(check.turn)
            ? h(
                "button",
                {
                  type: "button",
                  class: "link-button",
                  onclick: () => {
                    setFollow(false);
                    select(check.turn);
                    showView("turns");
                  },
                },
                "Show turn",
              )
            : null,
        ),
      ),
    );
    ui.checkRows.replaceChildren(...rows);
  }

  function renderTurn() {
    const turn = state.turns.get(view.selected);
    if (!turn) {
      ui.turn.replaceChildren(
        h(
          "div",
          { class: "empty" },
          h("h2", null, state.order.length ? "Pick a turn" : "No turns yet"),
          h(
            "p",
            null,
            state.order.length
              ? "Choose a turn on the left to see what opencode sent, what went to Copilot, and what came back."
              : "Use opencode with an m365 model. Each request appears here as it happens: what opencode sent, the exact text Copilot received, its reply, and what the gateway checked.",
          ),
        ),
      );
      return;
    }
    if (turn.kind === "title") {
      ui.turn.replaceChildren(
        h("header", { class: "turn-head" }, h("h2", null, "Session title, made locally"), h("p", { class: "turn-meta" }, h("span", null, formatTime(turn.at)))),
        h("p", { class: "note" }, `opencode asked for a session title. The gateway wrote one itself ("${turn.title.title}") instead of asking Copilot, because every extra Copilot conversation counts toward Microsoft's throttle. Nothing left this machine.`),
      );
      return;
    }

    const summary = summarizeTurn(turn);
    const meta = [formatTime(turn.at), ...summary.meta];
    const steps = [h("div", { class: "ledger-head", "aria-hidden": "true" }, h("span", null, "This machine"), h("span", null), h("span", null, "Microsoft 365"))];
    if (turn.request) steps.push(step("local", null, requestEntry(turn)));
    for (const attempt of turn.attempts) {
      if (attempt.send) steps.push(step("remote", "→", sendEntry(turn, attempt)));
      if (attempt.activity.length) steps.push(step("remote", null, activityEntry(attempt)));
      if (attempt.reply) steps.push(step("remote", null, replyEntry(attempt)));
    }
    steps.push(step("local", turn.result || turn.error ? "←" : null, outcomeEntry(turn)));

    ui.turn.replaceChildren(
      h("header", { class: "turn-head" }, h("h2", null, summary.what), h("p", { class: "turn-meta" }, meta.map((part) => h("span", null, part)))),
      h("div", { class: "ledger" }, steps),
      checksSection(turn),
    );
  }

  function step(side, arrow, entry) {
    entry.classList.add(side);
    return h("div", { class: "step" }, entry, arrow ? h("span", { class: "cross", "aria-hidden": "true", title: arrow === "→" ? "Sent to Microsoft" : "Back on this machine" }, arrow) : null);
  }

  function requestEntry(turn) {
    const request = turn.request;
    const kept = request.toolsKept ?? [];
    const offered = request.toolsOffered ?? [];
    const left = offered.filter((name) => !kept.includes(name));
    const fresh = request.total - request.alreadySent;
    return h(
      "section",
      { class: "entry" },
      h("h3", null, "opencode sent"),
      h(
        "dl",
        { class: "kv" },
        h("dt", null, "Model"),
        h("dd", null, request.tone ? `${request.model} (${request.tone})` : request.model),
        h("dt", null, "Messages"),
        h("dd", null, `${request.total} in the request, ${request.alreadySent} already with Copilot, ${fresh} new`),
        request.session ? [h("dt", null, "Session"), h("dd", null, request.session)] : null,
        h("dt", null, "Tools passed on"),
        h("dd", null, kept.length ? kept.join(", ") : "none"),
        left.length ? [h("dt", null, "Tools left out"), h("dd", null, left.join(", "))] : null,
        request.images ? [h("dt", null, "Images"), h("dd", null, String(request.images))] : null,
      ),
      (request.messages ?? []).map((message, index) =>
        h(
          "div",
          { class: "message" },
          h(
            "p",
            { class: "message-label" },
            message.role === "tool" && message.toolName ? `Tool result from ${message.toolName}` : (ROLE_LABELS[message.role] ?? message.role),
            h("span", null, linesLabel(countLines(message.text))),
          ),
          message.text ? payload(`${turn.id}:m${index}`, message.text) : h("p", { class: "note" }, "(no text)"),
          (message.toolCalls ?? []).map((call) => h("p", { class: "note" }, `Called ${describeCall(call)}`)),
        ),
      ),
    );
  }

  function sendEntry(turn, attempt) {
    const send = attempt.send;
    const secrets = attempt.n === 1 ? turn.checks.find((check) => check.check === "secrets") : undefined;
    const findings = Array.isArray(secrets?.detail) ? secrets.detail : [];
    return h(
      "section",
      { class: "entry" },
      h("h3", null, send.nudge ? "Sent to Copilot: the follow-up" : "Sent to Copilot"),
      send.nudge ? h("p", { class: "note" }, "Copilot said it could not act on the files, so the gateway asked once more in the same conversation.") : null,
      h("p", { class: "note" }, `The exact text Copilot received, ${linesLabel(countLines(send.text))}.`),
      payload(`${turn.id}:s${attempt.n}`, send.text, { findings, copy: true }),
      h(
        "details",
        null,
        h("summary", null, "Connection and request envelope"),
        h(
          "dl",
          { class: "kv" },
          h("dt", null, "Host"),
          h("dd", null, send.host),
          h("dt", null, "Path"),
          h("dd", null, send.path),
          Object.entries(send.params ?? {}).map(([key, value]) => [h("dt", null, key), h("dd", null, value)]),
          h("dt", null, "access_token"),
          h("dd", null, "(sent, never recorded)"),
        ),
        h("pre", { class: "payload" }, JSON.stringify(send.envelope, null, 2)),
      ),
    );
  }

  function activityEntry(attempt) {
    return h(
      "section",
      { class: "entry" },
      h("h3", null, "What Copilot did"),
      h(
        "ul",
        { class: "activity" },
        attempt.activity.map((item) =>
          h(
            "li",
            null,
            h("span", { class: "what" }, ACTIVITY_LABELS[item.type] ?? item.type),
            h(
              "span",
              { class: "said" },
              item.grounding ? h("span", { class: `ground ${item.grounding}` }, `${GROUNDING_WORDS[item.grounding] ?? item.grounding}: `) : null,
              item.text || (item.hosts ?? []).join(", ") || "(no text)",
            ),
          ),
        ),
      ),
    );
  }

  function replyEntry(attempt) {
    const reply = attempt.reply;
    const scores = Object.entries(reply.scores ?? {});
    return h(
      "section",
      { class: "entry" },
      h("h3", null, "Copilot replied"),
      payload(`${reply.turn}:r${attempt.n}`, reply.text || "(empty)"),
      h(
        "dl",
        { class: "kv" },
        h("dt", null, "Took"),
        h("dd", null, formatDuration(reply.ms)),
        reply.contentOrigin ? [h("dt", null, "Answered by"), h("dd", null, reply.contentOrigin)] : null,
        reply.throttle ? [h("dt", null, "Messages used"), h("dd", null, `${reply.throttle.current} of ${reply.throttle.max} in this conversation`)] : null,
        reply.turnCount !== undefined ? [h("dt", null, "Conversation turn"), h("dd", null, String(reply.turnCount))] : null,
        scores.length ? [h("dt", null, "Classifier scores"), h("dd", null, scores.map(([key, value]) => `${key} ${value}`).join(", "))] : null,
        reply.resultValue && reply.resultValue !== "Success" ? [h("dt", null, "Result"), h("dd", null, reply.resultValue)] : null,
        reply.sources?.length
          ? [h("dt", null, "Sources cited"), h("dd", null, reply.sources.map((source) => `${source.title ?? source.host} (${GROUNDING_WORDS[source.kind] ?? source.kind})`).join(", "))]
          : null,
      ),
    );
  }

  function outcomeEntry(turn) {
    const parts = [h("h3", null, "Handed to opencode")];
    if (turn.error) {
      const held = turn.error.code === "m365_work_data_held";
      parts.push(
        h(
          "div",
          { class: `callout ${held || turn.error.code === "m365_disengaged" ? "stop" : "warn"}` },
          h("strong", null, held ? "Nothing. The gateway held the reply." : `An error: ${turn.error.code}`),
          turn.error.message,
        ),
      );
    } else if (turn.result) {
      const result = turn.result;
      if (result.toolCalls.length) {
        parts.push(h("p", { class: "note" }, result.toolCalls.length === 1 ? "A tool call, which opencode runs on this machine." : `${result.toolCalls.length} tool calls, which opencode runs on this machine.`));
        result.toolCalls.forEach((call, index) => {
          parts.push(h("div", { class: "call" }, h("span", { class: "call-name" }, call.name), payload(`${turn.id}:c${index}`, call.arguments)));
        });
      } else {
        parts.push(h("p", { class: "note" }, result.streamed ? "Text, streamed to opencode as it arrived." : "Text."), payload(`${turn.id}:t`, result.text || "(empty)"));
      }
      if (result.skippedCalls) parts.push(h("p", { class: "note" }, `Copilot wrote ${result.skippedCalls} more ${result.skippedCalls === 1 ? "call" : "calls"}; only the first runs, since the rest were written before any result.`));
      if (result.inventedResult) parts.push(h("p", { class: "note" }, "Copilot also guessed the call's result; the guess was set aside."));
      if (result.note) parts.push(h("p", { class: "note" }, `Copilot is told next turn: ${result.note}`));
    } else {
      parts.push(h("p", { class: "note" }, "Waiting for Copilot…"));
    }
    return h("section", { class: "entry" }, parts);
  }

  function checksSection(turn) {
    if (turn.checks.length === 0) return h("section", { class: "turn-checks" }, h("h3", null, "Checks"), h("p", { class: "note" }, "No checks recorded for this turn yet."));
    return h(
      "section",
      { class: "turn-checks" },
      h("h3", null, "Checks"),
      h(
        "ul",
        { class: "check-list" },
        turn.checks.map((check) =>
          h(
            "li",
            null,
            h("span", { class: `verdict ${check.verdict}` }, VERDICT_WORDS[check.verdict] ?? check.verdict),
            h(
              "div",
              null,
              h("span", { class: "check-what" }, CHECK_LABELS[check.check] ?? check.check),
              check.summary,
              check.check === "secrets" && Array.isArray(check.detail)
                ? h(
                    "ul",
                    { class: "findings" },
                    check.detail.slice(0, 12).map((finding) => h("li", null, `${finding.kind} on line ${finding.line}: `, h("code", null, finding.preview))),
                  )
                : null,
            ),
          ),
        ),
      ),
    );
  }

  /** A block of verbatim text: clipped when long, with secret-like spans marked. */
  function payload(key, text, options = {}) {
    const value = String(text ?? "");
    const lines = countLines(value);
    const long = lines > CLIP_LINES || value.length > CLIP_CHARS;
    // Text with marked findings opens in full, so the marks are not hidden by the clip.
    const open = view.expanded.has(key) || (!view.collapsed.has(key) && (options.findings?.length ?? 0) > 0);
    const pre = h("pre", { class: `payload${long && !open ? " clipped" : ""}` });
    appendMarked(pre, value, options.findings ?? []);
    const tools = [];
    if (long) {
      tools.push(
        h(
          "button",
          {
            type: "button",
            "aria-expanded": String(open),
            onclick: (event) => {
              const nowOpen = pre.classList.contains("clipped");
              if (nowOpen) {
                view.expanded.add(key);
                view.collapsed.delete(key);
              } else {
                view.expanded.delete(key);
                view.collapsed.add(key);
              }
              pre.classList.toggle("clipped", !nowOpen);
              event.currentTarget.setAttribute("aria-expanded", String(nowOpen));
              event.currentTarget.textContent = nowOpen ? "Show less" : `Show all ${linesLabel(lines)}`;
            },
          },
          open ? "Show less" : `Show all ${linesLabel(lines)}`,
        ),
      );
    }
    if (options.copy && navigator.clipboard?.writeText) {
      tools.push(
        h(
          "button",
          {
            type: "button",
            onclick: async (event) => {
              const button = event.currentTarget;
              try {
                await navigator.clipboard.writeText(value);
                button.textContent = "Copied";
              } catch {
                button.textContent = "Copy failed";
              }
              setTimeout(() => (button.textContent = "Copy text"), 1500);
            },
          },
          "Copy text",
        ),
      );
    }
    if (options.findings?.length) tools.push(h("span", null, `${options.findings.length} key-like ${options.findings.length === 1 ? "string" : "strings"} marked`));
    return tools.length ? h("div", null, pre, h("div", { class: "payload-tools" }, tools)) : pre;
  }

  function appendMarked(pre, text, findings) {
    let cursor = 0;
    const spans = findings
      .filter((finding) => Number.isInteger(finding.index) && Number.isInteger(finding.length) && finding.index >= 0)
      .sort((a, b) => a.index - b.index);
    for (const finding of spans) {
      if (finding.index < cursor || finding.index >= text.length) continue;
      pre.append(text.slice(cursor, finding.index));
      pre.append(h("mark", { title: `Looks like a ${finding.kind}` }, text.slice(finding.index, finding.index + finding.length)));
      cursor = finding.index + finding.length;
    }
    pre.append(text.slice(cursor));
  }

  // --- state changes ---

  function select(id) {
    if (!state.turns.has(id)) return;
    view.selected = id;
    dirty.all = true;
    schedule();
  }

  function setFollow(on) {
    view.follow = on;
    ui.follow.checked = on;
  }

  function showView(name) {
    const turns = name === "turns";
    ui.turnsView.hidden = !turns;
    ui.checksView.hidden = turns;
    const [current, other] = turns ? [ui.viewTurns, ui.viewChecks] : [ui.viewChecks, ui.viewTurns];
    current.setAttribute("aria-current", "page");
    other.removeAttribute("aria-current");
  }

  function setLinkState(stateName, text) {
    ui.linkState.dataset.state = stateName;
    ui.linkState.textContent = text;
  }
}

function takeToken() {
  const match = /(?:^#|&)k=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (match) {
    try {
      sessionStorage.setItem("gateway-monitor-key", match[1]);
    } catch {
      /* storage refused; the key lives for this page load only */
    }
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  try {
    return sessionStorage.getItem("gateway-monitor-key");
  } catch {
    return null;
  }
}

function forgetToken() {
  try {
    sessionStorage.removeItem("gateway-monitor-key");
  } catch {
    /* nothing kept */
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
