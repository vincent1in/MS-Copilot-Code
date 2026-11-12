/*
 * The Microsoft Copilot gateway's page. Plain JavaScript with no dependencies and
 * nothing loaded from anywhere but the gateway itself.
 *
 * Four tabs: Set up (sign in, a test message, connecting OpenCode), Traffic (every
 * turn, laid out across the border between this machine and Microsoft 365), Checks
 * (everything the gateway checked), and Settings.
 *
 * Everything shown came from OpenCode, from Copilot, or from files the agent read, so
 * all of it is untrusted text: it only ever reaches the page through text nodes,
 * never as HTML. (The page's content security policy would stop a script from
 * running anyway; this makes sure markup never even renders.)
 *
 * The page's key arrives in the link's fragment (#k=…), which browsers do not send to
 * servers. It is moved into this tab's session storage — so a reload still works and
 * closing the tab forgets it — and taken out of the address bar.
 */

// --- pure helpers (unit-tested in ui.test.ts) -------------------------------------------

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
  return { facts: null, limits: null, setup: false, turns: new Map(), order: [], checks: [] };
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
 * "checks" for a check with no turn, "app" for a change on the Set up or Settings
 * side, or null for nothing visible.
 */
export function applyEvent(state, event) {
  if (!event || typeof event !== "object") return null;
  switch (event.kind) {
    case "hello":
      state.facts = event.facts ?? null;
      state.limits = event.limits ?? null;
      state.setup = event.setup === true;
      resetTurns(state);
      return "*";
    case "cleared":
      resetTurns(state);
      return "*";
    case "live":
      return null;
    case "app-changed":
      return "app";
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
  cancelled: "Cancelled by OpenCode",
  upstream_error: "Connection to Copilot failed",
};

/** The connection test's sessions are named so they can be labelled here. */
export function isTestSession(session) {
  return typeof session === "string" && session.startsWith("connection-test-");
}

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
  if (isTestSession(turn.request?.session)) meta.push("Test message");
  else if (turn.request?.session) meta.push(`session ${shortId(turn.request.session)}`);
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

/** Which tab to open on: Set up until you are signed in and OpenCode is connected. */
export function landingTab(app) {
  if (!app) return "turns";
  return app.account && app.opencode?.connected ? "turns" : "setup";
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

// --- words ------------------------------------------------------------------------------

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

const PURPOSE_WORDS = { auth: "signing in", chat: "Copilot" };

/** What to do about a failed test message, by the code the gateway gave it. */
const TEST_ADVICE = {
  authentication_required: "Sign in again (step 1), then send another test.",
  m365_throttled: "Microsoft is limiting this account for now. Wait a while before trying again; retrying sooner makes it last longer.",
  m365_not_served: "Your account can't use that model. Try GPT-6.1 Sol.",
  m365_turn_rejected: "Copilot no longer offers that model. Try GPT-6.1 Sol.",
  m365_disengaged: "Copilot declined to answer. Send the test again.",
  m365_work_data_held: "Copilot used your work data, so the gateway held the reply. See Settings, under Your data.",
  upstream_error: "The gateway could not reach Copilot. Check this computer's network connection.",
};

/** The Settings tab: every setting, in plain words. Values are what the gateway reads. */
const SETTING_GROUPS = [
  {
    title: "Your data",
    items: [
      {
        key: "workIq",
        name: "When Copilot uses your work data (Work IQ)",
        help: "If your account has Work IQ, Copilot can draw on your email, files, chats and meetings. The gateway never asks for that, and checks every reply for signs of it. Holding means OpenCode gets an error instead of that reply.",
        options: [
          ["hold", "Hold the reply (recommended)"],
          ["flag", "Let it through, and flag it in Checks"],
          ["allow", "Let it through"],
        ],
      },
      {
        key: "webSearch",
        name: "Bing web search",
        help: "With it on, Copilot may turn parts of your code into Bing searches.",
        options: [
          [false, "Off (recommended)"],
          [true, "On"],
        ],
      },
    ],
  },
  {
    title: "How the gateway talks to Copilot",
    items: [
      {
        key: "lean",
        name: "Trim OpenCode's tools",
        help: "Copilot stops answering when it is offered a dozen tools or more, so the gateway passes on only the core ones: run a command, read, write, edit, patch and search.",
        options: [
          [true, "On (recommended)"],
          [false, "Off"],
        ],
      },
      {
        key: "localTitles",
        name: "Write session titles on this computer",
        help: "OpenCode asks the model to title every new session. Answering here saves a Copilot conversation each time, which keeps you clear of Microsoft's limits.",
        options: [
          [true, "On (recommended)"],
          [false, "Off"],
        ],
      },
      {
        key: "leanSystemPrompt",
        name: "Short system prompt",
        tag: "experimental",
        help: "Replaces OpenCode's long instructions to the model with six short lines. It can help Copilot use tools, but your project's own AGENTS.md rules may not reach it.",
        options: [
          [false, "Off"],
          [true, "On"],
        ],
      },
      {
        key: "setDefaultModel",
        name: "Default model in OpenCode",
        help: "Use m365/gpt-6.1-sol when you haven't picked a model in OpenCode.",
        options: [
          [true, "On"],
          [false, "Off"],
        ],
      },
    ],
  },
  {
    title: "This page and signing in",
    items: [
      {
        key: "pageWithOpenCode",
        name: "When OpenCode starts",
        help: "OpenCode runs its own copy of the gateway. Turn this on to watch OpenCode's turns on a page like this one. Either way, nothing is kept after OpenCode stops.",
        applies: "next start",
        options: [
          ["off", "Don't start this page"],
          ["on", "Start it (open it with opencode-m365 open)"],
          ["open", "Start it and open it in the browser"],
        ],
      },
      {
        key: "signInBrowser",
        name: "Browser for signing in",
        help: "A browser you already have. Sign-in happens in a separate window with its own profile, so it never touches your everyday browsing.",
        options: [
          ["auto", "Edge, or Chrome if Edge isn't installed"],
          ["msedge", "Microsoft Edge"],
          ["chrome", "Google Chrome"],
        ],
      },
    ],
  },
];

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
  for (const child of present(children)) element.append(child instanceof Node ? child : String(child));
  return element;
}

/** Replace an element's contents. Like h(), it skips empty children and flattens lists. */
function fill(element, ...children) {
  element.replaceChildren(...present(children));
}

function present(children) {
  return children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false);
}

// --- the page ---------------------------------------------------------------------------

function boot() {
  const state = createState();
  const ui = {
    linkState: document.getElementById("link-state"),
    who: document.getElementById("who"),
    follow: document.getElementById("follow"),
    pause: document.getElementById("pause"),
    clear: document.getElementById("clear"),
    list: document.getElementById("turn-list"),
    turn: document.getElementById("turn"),
    tabs: {
      setup: document.getElementById("view-setup"),
      turns: document.getElementById("view-turns"),
      checks: document.getElementById("view-checks"),
      settings: document.getElementById("view-settings"),
    },
    views: {
      setup: document.getElementById("setup-view"),
      turns: document.getElementById("turns-view"),
      checks: document.getElementById("checks-view"),
      settings: document.getElementById("settings-view"),
    },
    checkRows: document.getElementById("check-rows"),
  };
  const view = {
    tab: "turns",
    landed: false,
    selected: null,
    follow: true,
    paused: false,
    queue: [],
    arrived: new Set(),
    expanded: new Set(),
    collapsed: new Set(),
    saved: null,
  };
  const app = { state: null, error: null, fetching: null, again: false };
  const dirty = { all: true, turns: new Set(), checks: true, app: true };
  let frame = 0;

  const token = takeToken();
  if (!token) {
    setLinkState("refused", "This page needs its key. Open it from the link that `opencode-m365 start` or `opencode-m365 open` gives you.");
    render();
    return;
  }

  for (const [name, tab] of Object.entries(ui.tabs)) tab.addEventListener("click", () => showView(name));
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

  // --- the live stream ---

  async function connect() {
    let delay = 1000;
    for (;;) {
      try {
        setLinkState("connecting", "Connecting…");
        const response = await fetch("/events", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (response.status === 401) {
          forgetToken();
          setLinkState("refused", "This link's key is out of date: the key changes every time the gateway starts. Run `opencode-m365 open` for the current link.");
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
    // A fresh snapshot, a clear and Set up changes always apply, even when paused.
    if (view.paused && !["hello", "cleared", "app-changed"].includes(event.kind)) {
      view.queue.push(event);
      setLinkState("paused", `Paused, ${view.queue.length} new`);
      return;
    }
    if (event.kind === "hello" || event.kind === "cleared") view.queue.length = 0;
    take(event);
  }

  function take(event) {
    const changed = applyEvent(state, event);
    if (event.kind === "hello" && state.setup) refreshApp();
    if (changed === null) return;
    if (changed === "app") {
      refreshApp();
      return;
    }
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
    schedule();
  }

  // --- the Set up and Settings state ---

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error || `The gateway answered ${response.status}.`);
    return value;
  }

  /** Re-read the Set up state; coalesces bursts of change notices into one request. */
  async function refreshApp() {
    if (app.fetching) {
      app.again = true;
      return app.fetching;
    }
    app.fetching = (async () => {
      do {
        app.again = false;
        try {
          app.state = await api("/api/state");
          app.error = null;
        } catch (error) {
          app.error = error.message;
        }
      } while (app.again);
    })();
    await app.fetching;
    app.fetching = null;
    if (!view.landed && app.state) {
      view.landed = true;
      showView(landingTab(app.state));
    }
    dirty.app = true;
    schedule();
  }

  async function saveSetting(key, value) {
    view.saved = { key, ok: true, text: "Saving…" };
    dirty.app = true;
    schedule();
    try {
      app.state = await api("/api/settings", { key, value });
      view.saved = { key, ok: true, text: "Saved" };
    } catch (error) {
      view.saved = { key, ok: false, text: error.message };
    }
    dirty.app = true;
    schedule();
    setTimeout(() => {
      if (view.saved?.key === key && view.saved.ok) {
        view.saved = null;
        dirty.app = true;
        schedule();
      }
    }, 2500);
  }

  async function signIn() {
    try {
      app.state = await api("/api/sign-in", {});
    } catch (error) {
      app.error = error.message;
    }
    dirty.app = true;
    schedule();
  }

  async function sendTest(model) {
    try {
      await api("/api/test", { model });
    } catch (error) {
      app.error = error.message;
    }
    await refreshApp();
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
    // Keep keyboard focus where it was across a re-render: controls have stable ids.
    const focused = document.activeElement?.id;
    renderTabs();
    renderWho();
    renderList();
    if (dirty.all || dirty.turns.has(view.selected)) renderTurn();
    if (dirty.all || dirty.checks) renderChecks();
    if (dirty.all || dirty.app) {
      renderSetup();
      renderSettings();
    }
    dirty.all = false;
    dirty.turns.clear();
    dirty.checks = false;
    dirty.app = false;
    if (focused && document.activeElement?.id !== focused) document.getElementById(focused)?.focus();
  }

  function renderTabs() {
    ui.tabs.setup.hidden = !state.setup;
    ui.tabs.settings.hidden = !state.setup;
  }

  function renderWho() {
    const account = app.state?.account;
    if (!state.setup || !app.state) {
      fill(ui.who);
      return;
    }
    fill(ui.who, account ? h("span", null, "Signed in as ", h("strong", null, account)) : "Not signed in");
  }

  function renderList() {
    const rows = state.order.map((id) => {
      const turn = state.turns.get(id);
      const summary = summarizeTurn(turn);
      return h(
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
    });
    view.arrived.clear();
    fill(ui.list, ...rows);
    const selected = ui.list.querySelector('[aria-selected="true"]');
    if (selected && view.follow && view.tab === "turns") selected.scrollIntoView({ block: "nearest" });
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
    fill(ui.checkRows, ...rows);
  }

  // --- Set up ---

  function renderSetup() {
    const s = app.state;
    if (!state.setup) return;
    if (!s) {
      fill(ui.views.setup, h("p", { class: "note" }, app.error ? `Could not load this page's state: ${app.error}` : "Loading…"));
      return;
    }
    const inside = s.context === "opencode";
    fill(ui.views.setup,
      h("h2", null, "Set up"),
      h(
        "p",
        { class: "lede" },
        "This gateway lets OpenCode use Microsoft Copilot, on your work account, as its AI model. It runs on this computer.",
      ),
      h(
        "div",
        { class: "hosts" },
        h("p", null, "It connects to exactly two addresses, both Microsoft's, and refuses every other:"),
        h(
          "ul",
          null,
          s.hosts.map((entry) => h("li", null, h("code", null, entry.host), ` for ${PURPOSE_WORDS[entry.purpose] ?? entry.purpose}`)),
        ),
        h("p", { class: "setting-note" }, "No analytics or usage reports go anywhere. The Checks tab lists every connection it makes."),
      ),
      app.error ? h("div", { class: "callout warn" }, app.error) : null,
      h("ol", { class: "steps" }, signInStep(s), testStep(s), connectStep(s, inside), watchStep(s, inside)),
    );
  }

  function step(number, done, title, ...body) {
    return h(
      "li",
      { class: `step${done ? " done" : ""}` },
      h("span", { class: "step-mark", "aria-hidden": "true" }, done ? "✓" : String(number)),
      h("h3", null, title),
      ...body,
    );
  }

  function status(done, text) {
    return h("p", { class: `step-status ${done ? "done" : "todo"}` }, text);
  }

  function signInStep(s) {
    const signedIn = Boolean(s.account);
    const body = [status(signedIn, signedIn ? `Signed in as ${s.account}.` : "Not signed in yet.")];
    if (s.signIn.available) {
      const browser = s.settings.signInBrowser;
      body.push(
        h("p", null, "Use your work or school account. A browser window opens on Microsoft's sign-in page; finish there, including any multi-factor prompt."),
        h(
          "div",
          { class: "row" },
          h("label", { for: "sign-in-browser" }, "Sign in with"),
          h(
            "select",
            {
              id: "sign-in-browser",
              disabled: Boolean(browser.lockedBy) || s.signIn.running,
              onchange: (event) => saveSetting("signInBrowser", event.currentTarget.value),
            },
            SETTING_GROUPS[2].items[1].options.map(([value, label]) => h("option", { value, selected: browser.value === value }, label)),
          ),
          h(
            "button",
            { type: "button", class: "primary", id: "sign-in", disabled: s.signIn.running, onclick: () => signIn() },
            s.signIn.running ? "Waiting for you in the browser…" : signedIn ? "Sign in again" : "Sign in",
          ),
        ),
        s.signIn.running ? h("p", { class: "note" }, "Finish signing in in the window that opened. This page updates by itself when you're done.") : null,
        s.signIn.error ? h("div", { class: "callout warn" }, h("strong", null, "Sign-in didn't finish."), s.signIn.error) : null,
        h("p", { class: "setting-note" }, "Only the sign-in token is kept, in a file only you can read. Your password never reaches the gateway."),
      );
    } else if (!signedIn) {
      body.push(
        h("p", null, "Signing in opens a browser window, which this page can't do from inside OpenCode. Run this in a terminal, then come back:"),
        snippet("sign-in-command", s.signIn.command),
      );
    }
    return step(1, signedIn, "Sign in to Microsoft 365", ...body);
  }

  function testStep(s) {
    const last = s.test.last;
    const ok = last?.ok === true;
    const body = [
      status(ok, ok ? "Copilot answered." : last ? "The last test didn't get through." : "Not sent yet."),
      h("p", null, "Sends this one message to Copilot through the gateway, so you can see exactly what goes out and what comes back:"),
      h("p", { class: "quote" }, s.test.prompt),
      h(
        "div",
        { class: "row" },
        h("label", { for: "test-model" }, "Model"),
        h("select", { id: "test-model", disabled: s.test.running }, s.models.map((model) => h("option", { value: model.id, selected: model.id === (last?.model ?? s.defaultModel) }, model.name))),
        h(
          "button",
          {
            type: "button",
            class: "primary",
            id: "send-test",
            disabled: s.test.running || !s.account,
            onclick: () => sendTest(document.getElementById("test-model").value),
          },
          s.test.running ? "Waiting for Copilot…" : "Send test message",
        ),
        !s.account ? h("span", { class: "note" }, "Sign in first.") : null,
      ),
    ];
    if (s.test.running) body.push(h("p", { class: "note" }, "Reasoning models can take 10 to 30 seconds to answer."));
    if (last && !s.test.running) {
      if (last.ok) {
        body.push(
          h(
            "div",
            { class: "answer" },
            h("p", null, `Copilot replied in ${formatDuration(last.ms)}:`),
            h("p", { class: "quote" }, last.reply || "(an empty reply)"),
            h("button", { type: "button", class: "link-button", onclick: () => showTestTurn(last.session) }, "See exactly what was sent and received"),
          ),
        );
      } else {
        body.push(
          h(
            "div",
            { class: "callout warn" },
            h("strong", null, "It didn't get through."),
            last.error,
            TEST_ADVICE[last.code] ? h("p", null, TEST_ADVICE[last.code]) : null,
            h("button", { type: "button", class: "link-button", onclick: () => showTestTurn(last.session) }, "See the attempt in Traffic"),
          ),
        );
      }
    }
    body.push(h("p", { class: "setting-note" }, "Each test starts a new Copilot conversation, and Microsoft limits how fast those can start, so one test is plenty."));
    return step(2, ok, "Send a test message", ...body);
  }

  function connectStep(s, inside) {
    const oc = s.opencode;
    if (inside) return step(3, true, "Connect OpenCode", status(true, "Connected. This page is running inside OpenCode."));
    const pluginsJson = JSON.stringify({ plugins: [oc.pluginDir] }, null, 2);
    const quietJson = Object.entries(oc.quietSettings)
      .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(",\n");
    const allQuiet = Object.values(oc.quiet).every(Boolean);
    const overridden = oc.pluginOptions ? Object.keys(oc.pluginOptions).filter((key) => key !== "baseUrl" && key !== "apiKey") : [];
    return step(
      3,
      oc.connected,
      "Connect OpenCode",
      status(oc.connected, oc.connected ? "Connected. OpenCode loads the gateway from this folder." : "Not connected yet."),
      oc.problem ? h("div", { class: "callout warn" }, h("strong", null, "OpenCode's config file can't be read."), `${oc.configPath} is ${oc.problem}. Fix it first; the gateway won't change it.`) : null,
      h("p", null, "Use the OpenCode you already have. Tell it about the gateway in its config file:"),
      h(
        "ol",
        { class: "substeps" },
        h("li", null, "Open OpenCode's config file. Create it if it isn't there.", snippet("opencode-config-path", oc.configPath)),
        h(
          "li",
          null,
          "Add this folder to its plugins. In a new file, this is all it needs. If the file already has a ",
          h("code", null, "plugins"),
          " list, add the folder's path to that list instead.",
          snippet("opencode-plugins", pluginsJson),
        ),
        h(
          "li",
          null,
          allQuiet
            ? "Optional, and already done: OpenCode's own update checks, session sharing and web search are off."
            : "Optional: to stop OpenCode's own outside traffic as well (update checks, session sharing and its web search), add these lines inside the same braces:",
          allQuiet ? null : snippet("opencode-quiet", quietJson),
        ),
        h("li", null, "Start OpenCode in your project with ", h("code", null, "opencode"), ". Models starting with m365/ come from the gateway; m365/gpt-6.1-sol is used when you haven't picked one."),
      ),
      overridden.length
        ? h("p", { class: "setting-note locked" }, `OpenCode's config also sets ${overridden.join(", ")} for the gateway. Inside OpenCode those win over this page's Settings.`)
        : null,
      h("p", { class: "setting-note" }, "Rather run a command? ", h("code", null, "opencode-m365 setup --quiet"), " makes the same change and saves a backup of your config. This page never edits it."),
    );
  }

  function watchStep(s, inside) {
    const setting = s.settings.pageWithOpenCode;
    const on = setting.value !== "off";
    return step(
      4,
      inside || on,
      "See what OpenCode sends (optional)",
      inside
        ? status(true, "You're looking at it: this page belongs to the gateway inside OpenCode.")
        : status(on, setting.value === "open" ? "This page opens when OpenCode starts." : on ? "This page starts with OpenCode." : "Off."),
      inside ? null : h("p", null, "OpenCode runs its own copy of the gateway, so its turns show on that copy's page, not this one. Choose what happens when OpenCode starts:"),
      inside ? null : choiceControl(SETTING_GROUPS[2].items[0], setting, "watch"),
      inside ? null : h("p", { class: "setting-note" }, "If the page doesn't open by itself, run ", h("code", null, "opencode-m365 open"), "."),
    );
  }

  function showTestTurn(session) {
    const id = state.order.find((candidate) => state.turns.get(candidate)?.request?.session === session);
    if (id) {
      setFollow(false);
      select(id);
    }
    showView("turns");
  }

  /** A block of text to copy, with its button. */
  function snippet(id, text) {
    const pre = h("pre", { id: `${id}-text` }, text);
    const button = navigator.clipboard?.writeText
      ? h(
          "button",
          {
            type: "button",
            id: `${id}-copy`,
            onclick: async (event) => {
              const target = event.currentTarget;
              try {
                await navigator.clipboard.writeText(text);
                target.textContent = "Copied";
              } catch {
                target.textContent = "Copy failed";
              }
              setTimeout(() => (target.textContent = "Copy"), 1500);
            },
          },
          "Copy",
        )
      : null;
    return h("div", { class: "snippet" }, pre, button);
  }

  // --- Settings ---

  function renderSettings() {
    const s = app.state;
    if (!state.setup) return;
    if (!s) {
      fill(ui.views.settings, h("p", { class: "note" }, app.error ? `Could not load the settings: ${app.error}` : "Loading…"));
      return;
    }
    fill(ui.views.settings,
      h("h2", null, "Settings"),
      h(
        "p",
        { class: "lede" },
        "Saved on this computer and used by every copy of the gateway, including the one inside OpenCode. Changes apply from the next message, except where a setting says otherwise.",
      ),
      SETTING_GROUPS.map((group) =>
        h(
          "section",
          { class: "settings-group" },
          h("h3", null, group.title),
          group.items.map((item) => settingRow(item, s.settings[item.key])),
        ),
      ),
      h("p", { class: "setting-note" }, "Saved in ", h("code", null, s.settingsFile), " (readable only by you)."),
    );
  }

  function settingRow(item, setting) {
    const note = setting.lockedBy
      ? h("p", { class: "setting-note locked" }, `Set by ${setting.lockedBy}. Change it there.`)
      : item.applies === "next start"
        ? h("p", { class: "setting-note" }, "Applies the next time OpenCode starts.")
        : null;
    return h(
      "div",
      { class: "setting" },
      h(
        "div",
        null,
        h("p", { class: "setting-name", id: `setting-${item.key}-name` }, item.name, item.tag ? h("span", { class: "tag" }, item.tag) : null),
        h("p", { class: "setting-help" }, item.help),
        note,
      ),
      choiceControl(item, setting, "setting"),
    );
  }

  /** The radio group for one setting; saves on change. */
  function choiceControl(item, setting, prefix) {
    const saved = view.saved?.key === item.key ? view.saved : null;
    return h(
      "fieldset",
      { class: "choices", "aria-labelledby": prefix === "setting" ? `setting-${item.key}-name` : null, "aria-label": prefix === "setting" ? null : item.name },
      item.options.map(([value, label]) => {
        const id = `${prefix}-${item.key}-${String(value)}`;
        return h(
          "label",
          { for: id },
          h("input", {
            type: "radio",
            id,
            name: `${prefix}-${item.key}`,
            value: String(value),
            checked: setting.value === value,
            disabled: Boolean(setting.lockedBy),
            onchange: () => saveSetting(item.key, value),
          }),
          label,
        );
      }),
      h("span", { class: `saved${saved && !saved.ok ? " failed" : ""}`, role: "status" }, saved ? saved.text : ""),
    );
  }

  // --- Traffic: one turn ---

  function renderTurn() {
    const turn = state.turns.get(view.selected);
    if (!turn) {
      fill(ui.turn,
        h(
          "div",
          { class: "empty" },
          h("h2", null, state.order.length ? "Pick a turn" : "No turns yet"),
          h(
            "p",
            null,
            state.order.length
              ? "Choose a turn on the left to see what OpenCode sent, what went to Copilot, and what came back."
              : state.setup
                ? "Send a test message from Set up, or use OpenCode with an m365 model. Each request appears here as it happens: what was sent, the exact text Copilot received, its reply, and what the gateway checked."
                : "Use OpenCode with an m365 model. Each request appears here as it happens: what was sent, the exact text Copilot received, its reply, and what the gateway checked.",
          ),
        ),
      );
      return;
    }
    if (turn.kind === "title") {
      fill(ui.turn,
        h("header", { class: "turn-head" }, h("h2", null, "Session title, made locally"), h("p", { class: "turn-meta" }, h("span", null, formatTime(turn.at)))),
        h("p", { class: "note" }, `OpenCode asked for a session title. The gateway wrote one itself ("${turn.title.title}") instead of asking Copilot, because every extra Copilot conversation counts toward Microsoft's limits. Nothing left this machine.`),
      );
      return;
    }

    const summary = summarizeTurn(turn);
    const meta = [formatTime(turn.at), ...summary.meta];
    const steps = [h("div", { class: "ledger-head", "aria-hidden": "true" }, h("span", null, "This machine"), h("span", null), h("span", null, "Microsoft 365"))];
    if (turn.request) steps.push(ledgerStep("local", null, requestEntry(turn)));
    for (const attempt of turn.attempts) {
      if (attempt.send) steps.push(ledgerStep("remote", "→", sendEntry(turn, attempt)));
      if (attempt.activity.length) steps.push(ledgerStep("remote", null, activityEntry(attempt)));
      if (attempt.reply) steps.push(ledgerStep("remote", null, replyEntry(attempt)));
    }
    steps.push(ledgerStep("local", turn.result || turn.error ? "←" : null, outcomeEntry(turn)));

    fill(ui.turn,
      h("header", { class: "turn-head" }, h("h2", null, summary.what), h("p", { class: "turn-meta" }, meta.map((part) => h("span", null, part)))),
      h("div", { class: "ledger" }, steps),
      checksSection(turn),
    );
  }

  function ledgerStep(side, arrow, entry) {
    entry.classList.add(side);
    return h("div", { class: "step-row" }, entry, arrow ? h("span", { class: "cross", "aria-hidden": "true", title: arrow === "→" ? "Sent to Microsoft" : "Back on this machine" }, arrow) : null);
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
      h("h3", null, isTestSession(request.session) ? "The test message" : "OpenCode sent"),
      h(
        "dl",
        { class: "kv" },
        h("dt", null, "Model"),
        h("dd", null, request.tone ? `${request.model} (${request.tone})` : request.model),
        h("dt", null, "Messages"),
        h("dd", null, `${request.total} in the request, ${request.alreadySent} already with Copilot, ${fresh} new`),
        request.session && !isTestSession(request.session) ? [h("dt", null, "Session"), h("dd", null, request.session)] : null,
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
    const test = isTestSession(turn.request?.session);
    const parts = [h("h3", null, test ? "Back on the Set up page" : "Handed to OpenCode")];
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
        parts.push(h("p", { class: "note" }, result.toolCalls.length === 1 ? "A tool call, which OpenCode runs on this machine." : `${result.toolCalls.length} tool calls, which OpenCode runs on this machine.`));
        result.toolCalls.forEach((call, index) => {
          parts.push(h("div", { class: "call" }, h("span", { class: "call-name" }, call.name), payload(`${turn.id}:c${index}`, call.arguments)));
        });
      } else {
        parts.push(h("p", { class: "note" }, result.streamed ? "Text, streamed as it arrived." : "Text."), payload(`${turn.id}:t`, result.text || "(empty)"));
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
    if (!ui.views[name] || ui.tabs[name].hidden) name = "turns";
    view.tab = name;
    for (const [key, tab] of Object.entries(ui.tabs)) {
      const current = key === name;
      ui.views[key].hidden = !current;
      if (current) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if ((name === "setup" || name === "settings") && state.setup) refreshApp();
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
      sessionStorage.setItem("gateway-page-key", match[1]);
    } catch {
      /* storage refused; the key lives for this page load only */
    }
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  try {
    return sessionStorage.getItem("gateway-page-key");
  } catch {
    return null;
  }
}

function forgetToken() {
  try {
    sessionStorage.removeItem("gateway-page-key");
  } catch {
    /* nothing kept */
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
}
