/**
 * The OpenAI-compatible HTTP surface.
 *
 * Small on purpose: `node:http` rather than a framework, because this runs inside
 * opencode's own process and every dependency here is one opencode has to install.
 * It binds loopback only, and loopback is not a trust boundary: every browser tab on
 * the machine can reach it too. So every request must also carry a per-launch secret
 * (`Authorization: Bearer <apiKey>`), must name a loopback `Host` (DNS rebinding), and
 * must not come from a browser `Origin` the caller did not allow. No CORS headers are
 * ever sent — opencode is a server-side client and needs none.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AuthRequiredError } from "./auth.js";
import type { ParsedToolCall, ToolDef } from "./fenced.js";
import { DEFAULT_MODEL, isLocalModel, listModelIds, resolveModel, toolRouteFor } from "./models.js";
import { LEAN_SYSTEM_PROMPT, describeToolSelection, selectLeanTools } from "./config.js";
import { parseCodeModeCatalog, type CodeModeCatalog } from "./codemode.js";
import {
  MCP_TOOL_NAME,
  callCode,
  executeCodeToMcp,
  mcpTool,
  parseMcpBlock,
  renderInvalidMcpBlock,
  renderMcpFence,
  renderSearchResult,
  renderUnknownTool,
  resolveCallPath,
  searchCatalog,
  searchCode,
} from "./mcp.js";
import {
  CopilotSession,
  DisengagedError,
  M365ThrottledError,
  M365UnavailableError,
  PremiumLicenceRequiredError,
  PriorityAccessExhaustedError,
  TurnRejectedError,
  type TurnResult,
} from "./session.js";
import { createPrivateAppender } from "./private-fs.js";
import {
  ChatCompletionRequest,
  ConversationPool,
  buildCompletion,
  buildTurnPrompt,
  buildUsage,
  contentOf,
  generateTitle,
  streamChunk,
  streamDone,
  streamUsageChunk,
  estimateCompletionTokens,
  estimatePromptTokens,
  toOpenAiToolCall,
  type ChatRequest,
  type ConversationState,
} from "./translate.js";
import { collectImages } from "./image.js";
import { firstFenceBody, parseToolCalls } from "./fenced.js";
import { looksLikeGiveUp, nudgeFor } from "./giveup.js";
import { createLogger, redact } from "./log.js";
import { METRICS_PATH, SessionMetricsStore } from "./metrics.js";
import type { Monitor } from "./monitor/monitor.js";
import { recordEgress } from "./monitor/egress-feed.js";
import { turnScope } from "./monitor/scope.js";
import { TurnRecorder, summarizeMessages } from "./monitor/turn.js";
import { DEFAULT_WORK_IQ_POLICY, WorkDataHeldError, describeGrounding, judgeGrounding, type WorkIqPolicy } from "./workiq.js";

const log = createLogger("server");

/** See the warning in `handleChatCompletion`; this keeps it to once per process. */
let warnedAboutToolSelection = false;

/**
 * Header a harness uses to declare what an auxiliary request is *for*.
 *
 * Node lowercases incoming header names, so this must stay lowercase to match.
 *
 * Only `title` is acted on. Compaction and generation are real model work and belong
 * on the real model; titling is the one auxiliary request that would open a second
 * M365 conversation per session, which is precisely the throttle signature.
 */
export const AUX_REQUEST_KIND_HEADER = "x-m365-request-kind";

/**
 * Header a harness uses to name the session a request belongs to, so two sessions
 * that happen to open with the same message never share an M365 conversation.
 * Lowercase for the same reason as {@link AUX_REQUEST_KIND_HEADER}.
 */
export const SESSION_ID_HEADER = "x-m365-session-id";

export interface ServerDeps {
  /** Supplies a Sydney chat token. */
  getToken: () => Promise<string>;
  /** Override the M365 origin. Tests point this at a stub. */
  endpoint?: string;
  /** Keep every tool call the model emits rather than only the first. */
  allowMultiTool?: boolean;
  /** Offer Copilot's Bing web search plugin. Off by default. */
  webSearch?: boolean;
  /**
   * What to do with a reply Copilot grounded in your work data (Work IQ): `hold` it
   * (the default — opencode gets an error instead), `flag` it, or `allow` it.
   */
  workIq?: WorkIqPolicy;
  /** Records every turn for the gateway monitor. Absent, nothing is recorded. */
  monitor?: Monitor;
  /**
   * The settings in force, read once per request, so a change on the app's Settings
   * page applies from the next message. When given, it overrides `lean`,
   * `leanSystemPrompt`, `webSearch`, `workIq` and `mcpProxy`.
   */
  settings?: () => LiveSettings;
  /**
   * Trim the harness's toolset before the model sees it.
   *
   * The enforcement point for lean mode — opencode's own `tools` config does not
   * filter the outgoing request. See `selectLeanTools`.
   */
  lean?: boolean;
  /**
   * Replace the harness's prose system prompt with this leaner one.
   *
   * Done here rather than in the plugin because opencode's own system-prompt hook
   * does not affect the outgoing request — see `condenseSystemPrompt`.
   */
  leanSystemPrompt?: string;
  /**
   * Give Copilot one `mcp` tool for opencode 2's MCP tools. Off (the default), the
   * proxy strips the Code Mode catalogue and never offers `execute`, so M365 sees no
   * MCP tool at all. On, a search is answered here from the catalogue — sending the
   * matching tools' names, descriptions and arguments to M365 — and a call becomes an
   * `execute` call for opencode to run.
   */
  mcpProxy?: boolean;
  /**
   * Receives one entry per M365 turn: the raw reply, what was parsed from it, and
   * M365's diagnostics. Defaults to a JSONL file at `M365_TURN_LOG` when that is set,
   * and to nothing otherwise — the raw reply can hold anything from the workspace.
   */
  turnLog?: (entry: TurnLogEntry) => void;
  port?: number;
  /** Loopback only: `127.0.0.1` (the default), `::1` or `localhost`. Anything else throws. */
  host?: string;
  /**
   * The bearer secret every request must carry. Omit it and a fresh 32-byte random
   * one is generated per launch, which is what the in-process plugin wants: it hands
   * the key straight to opencode's provider config and nobody else ever sees it.
   */
  apiKey?: string;
  /**
   * @deprecated Ignored, with a warning. Every request carrying an `Origin` is refused:
   * opencode sends none, so one means a web page — and no allowlist could have made
   * the proxy usable from a page anyway, since the bearer header forces a CORS
   * preflight and preflights are always refused. Kept only so an old caller that
   * still passes it keeps starting.
   */
  allowedOrigins?: readonly string[];
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
  /**
   * Where per-session metrics go (model, quota, context, allowances), keyed by the
   * {@link SESSION_ID_HEADER}. A fresh one is made when this is omitted.
   */
  metrics?: SessionMetricsStore;
}

/** The settings a request reads. A subset of `GatewaySettings` (see settings.ts). */
export interface LiveSettings {
  workIq: WorkIqPolicy;
  webSearch: boolean;
  lean: boolean;
  leanSystemPrompt: boolean;
  mcpProxy: boolean;
}

/** What one request runs with: the live settings when given, else the fixed deps. */
interface RequestSettings {
  workIq: WorkIqPolicy;
  webSearch: boolean;
  lean: boolean;
  /** The replacement system prompt, when one is in force. */
  leanSystemPrompt?: string;
  mcpProxy: boolean;
}

function requestSettings(deps: ServerDeps): RequestSettings {
  const live = deps.settings?.();
  if (live) {
    return {
      workIq: live.workIq,
      webSearch: live.webSearch,
      lean: live.lean,
      ...(live.leanSystemPrompt ? { leanSystemPrompt: LEAN_SYSTEM_PROMPT } : {}),
      mcpProxy: live.mcpProxy,
    };
  }
  return {
    workIq: deps.workIq ?? DEFAULT_WORK_IQ_POLICY,
    webSearch: deps.webSearch === true,
    lean: deps.lean !== false,
    ...(deps.leanSystemPrompt !== undefined ? { leanSystemPrompt: deps.leanSystemPrompt } : {}),
    mcpProxy: deps.mcpProxy === true,
  };
}

export interface ProxyHandle {
  url: string;
  port: number;
  /** The bearer secret a client must send. */
  apiKey: string;
  /** Per-session metrics for opencode's UI, served by the plugin over RPC. */
  metrics: SessionMetricsStore;
  close(): Promise<void>;
}

/** Generous: a long agent history is a few MB of JSON; this only stops abuse. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** A fresh per-launch secret: 32 random bytes, base64url. */
export function generateApiKey(): string {
  return randomBytes(32).toString("base64url");
}

interface Conversation extends ConversationState {
  session?: CopilotSession;
  /** How the last reply was handled, when the model needs telling. Sent once, next turn. */
  note?: string;
  /** Tail of this conversation's turn queue: one M365 session runs one turn at a time. */
  turn?: Promise<void>;
}

/**
 * `mcp` blocks the proxy answers itself per request — searches, unknown paths and
 * unreadable blocks — before the reply goes back to the client as it is.
 */
export const MAX_MCP_SEARCHES = 3;

/** opencode 2's tool that runs Code Mode JavaScript: the proxy emits it, M365 never sees it. */
const EXECUTE_TOOL_NAME = "execute";

const isExecute = (tool: ToolDef) => tool.function.name.toLowerCase() === EXECUTE_TOOL_NAME;

export async function startServer(deps: ServerDeps): Promise<ProxyHandle> {
  const pool = new ConversationPool();
  const host = deps.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to bind ${host}: the proxy only listens on loopback (127.0.0.1, ::1, localhost)`);
  }
  const apiKey = deps.apiKey || generateApiKey();
  if (deps.allowedOrigins !== undefined) {
    process.emitWarning(
      "startServer's allowedOrigins option is ignored: the proxy refuses every request carrying an Origin, since browsers cannot use it.",
      { type: "DeprecationWarning", code: "M365_ALLOWED_ORIGINS" },
    );
  }
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const metrics = deps.metrics ?? new SessionMetricsStore();

  const portOf = () => (server.address() as AddressInfo).port;
  const server = createServer((request, response) => {
    handle(request, response, { deps, pool, apiKey, maxBodyBytes, metrics, port: portOf() }).catch((error) => {
      log.error("unhandled request failure", String(error));
      sendError(response, 500, "internal_error", String(error));
    });
  });

  // The monitor's checks trail hears every allowlist decision while this server runs.
  const stopEgressFeed = deps.monitor ? recordEgress(deps.monitor) : () => {};

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(deps.port ?? 0, host, resolve);
    });
  } catch (error) {
    stopEgressFeed();
    throw error;
  }

  const { port } = server.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${port}`,
    port,
    apiKey,
    metrics,
    close: () =>
      new Promise<void>((resolve) => {
        stopEgressFeed();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

interface Context {
  deps: ServerDeps;
  pool: ConversationPool;
  apiKey: string;
  maxBodyBytes: number;
  metrics: SessionMetricsStore;
  port: number;
}

class PayloadTooLargeError extends Error {}

/**
 * Is `Host` one of the names this listener is actually reachable by?
 *
 * A DNS-rebound page talks to 127.0.0.1 while its `Host` still names the attacker's
 * domain, so anything but a loopback name on our own port is refused.
 */
function isLoopbackHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim().toLowerCase());
  if (!match) return false;
  const name = match[1]!.replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(name) && Number(match[2] ?? 80) === port;
}

/** Constant-time check of `Authorization: Bearer <key>`. */
function hasApiKey(header: string | undefined, apiKey: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = (request.method ?? "GET").toUpperCase();

  // Order matters: the browser-shaped refusals come first, so a web page learns
  // nothing — not even whether it guessed the secret.
  if (!isLoopbackHost(request.headers.host, context.port)) {
    sendError(response, 403, "forbidden", "Host must be a loopback address");
    return;
  }

  // opencode sends no Origin; a request carrying one came from a web page.
  if (request.headers.origin !== undefined) {
    sendError(response, 403, "forbidden", "Browser origins may not use this proxy");
    return;
  }

  // Never grant a preflight: opencode does not send one, and a page that needs one
  // is exactly what this proxy must not serve.
  if (method === "OPTIONS") {
    sendError(response, 403, "forbidden", "CORS is not supported");
    return;
  }

  // Liveness only — carries nothing worth protecting, and lets a script check the
  // port without the secret.
  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (!hasApiKey(request.headers.authorization, context.apiKey)) {
    sendError(
      response,
      401,
      "invalid_api_key",
      "Missing or wrong proxy secret. Send `Authorization: Bearer <key>` with the key the proxy printed or was given (M365_PROXY_KEY).",
    );
    return;
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: listModelIds().map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "microsoft",
      })),
    });
    return;
  }

  // The session's metrics, for a plugin attached to this proxy with `baseUrl`: the
  // store lives here, out of that opencode process's reach (`remoteMetrics`).
  if (method === "GET" && url.pathname.startsWith(`/v1${METRICS_PATH}`)) {
    let sessionID = "";
    try {
      sessionID = decodeURIComponent(url.pathname.slice(`/v1${METRICS_PATH}`.length));
    } catch {
      // A malformed escape names no session.
    }
    sendJson(response, 200, { metrics: (sessionID && context.metrics.get(sessionID)) || null });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    await handleChatCompletion(request, response, context);
    return;
  }

  sendError(response, 404, "not_found", `No route for ${method} ${url.pathname}`);
}

async function handleChatCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  context: Context,
): Promise<void> {
  let body: ChatRequest;
  try {
    // `jitless` per call: zod v4 otherwise compiles a fast-path parser with
    // `new Function`. Passing it here rather than via z.config() matters: zod keeps its
    // config on globalThis, so a global setting would also change opencode's own zod.
    body = ChatCompletionRequest.parse(JSON.parse(await readBody(request, context.maxBodyBytes)), { jitless: true });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendError(response, 413, "request_too_large", error.message);
      request.resume();
      return;
    }
    sendError(response, 400, "invalid_request_error", String((error as Error)?.message ?? error));
    return;
  }

  const model = resolveModel(body.model);
  const settings = requestSettings(context.deps);
  const requested = (body.tools ?? []) as ToolDef[];
  const kept = settings.lean ? selectLeanTools(requested) : requested;
  if (kept.length !== requested.length) {
    log.info(`trimmed toolset ${requested.length} -> ${kept.length}`, kept.map((t) => t.function.name).join(","));
    // Reached only when the trim actually removed something, which cannot happen
    // with lean off. Warn once per process rather than per turn: a drifted
    // allowlist is a standing condition, not a per-request event.
    const concern = describeToolSelection(requested);
    if (concern && !warnedAboutToolSelection) {
      warnedAboutToolSelection = true;
      log.warn(concern);
    }
  }

  // opencode 2 lists its MCP tools in the system prompt's Code Mode catalogue, callable
  // only through `execute`. With the proxy on, M365 gets neither: one `mcp` tool stands
  // in for the whole catalogue, and the proxy turns its calls into `execute` calls.
  const catalog = settings.mcpProxy ? mcpCatalogFor(body, requested) : undefined;
  const tools = catalog ? [...kept.filter((tool) => !isExecute(tool)), mcpTool(catalog.tools, catalog.partial)] : kept;
  if (catalog) {
    log.info(
      `offering mcp over ${catalog.tools.length}${catalog.partial ? "+" : ""} Code Mode tools`,
      catalog.tools.map((tool) => tool.path).join(","),
    );
  }

  // The titler never touches M365 — see models.ts for why that matters. A harness
  // that cannot select the titler by id says so on the header instead; opencode 2
  // dropped `small_model`, and its title hook cannot change the model.
  if (isLocalModel(model.id) || request.headers[AUX_REQUEST_KIND_HEADER] === "title") {
    const title = respondWithTitle(response, body, model.id);
    context.deps.monitor?.emit({ kind: "title", model: model.id, title });
    return;
  }

  const sessionId = sessionIdOf(request);
  const conversation = context.pool.resolve(body.messages, sessionId ? { sessionId } : {}) as Conversation;

  // Serialise turns per conversation: two overlapping requests on one CopilotSession
  // would race its turn index and our sent-message count.
  const previous = conversation.turn ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  conversation.turn = previous.then(() => current);
  await previous;
  try {
    const offered = requested.map((tool) => tool.function.name);
    const recorder = new TurnRecorder(context.deps.monitor);
    // Everything this turn does — token refresh, uploads, the chat socket — runs in
    // its scope, so the monitor can tie each outbound connection to the turn.
    await turnScope.run(recorder.id, () =>
      runTurn(request, response, context, settings, body, conversation, model, tools, offered, sessionId, recorder, catalog, requested),
    );
  } finally {
    release();
  }
}

/** opencode's session id, from {@link SESSION_ID_HEADER}, when the request names one. */
function sessionIdOf(request: IncomingMessage): string | undefined {
  const header = request.headers[SESSION_ID_HEADER];
  return typeof header === "string" && header !== "" ? header : undefined;
}

export interface TurnLogEntry {
  time: string;
  model: string;
  tone: string | null;
  /** How the tool block was worded, on a tool turn. */
  framing?: "default" | "relay";
  tools: string[];
  reply?: string;
  toolCalls?: string[];
  contentOrigin?: string;
  turnCount?: number;
  throttle?: TurnResult["throttle"];
  scores?: Record<string, number>;
  resultValue?: string;
  /** This turn was the follow-up sent after a give-up. */
  nudged?: boolean;
  /** This turn was the reply to an `mcp` search the proxy answered; the query. */
  mcpSearch?: string;
  /**
   * This turn's reply was an `mcp` call the proxy sent to opencode as an `execute`
   * call: the tool's path, or `search` for opencode's own search.
   */
  mcpCall?: string;
  error?: string;
}

let envTurnLog: ((entry: TurnLogEntry) => void) | null | undefined;

/** The `M365_TURN_LOG` file writer, created on first use. */
function defaultTurnLog(): ((entry: TurnLogEntry) => void) | null {
  if (envTurnLog === undefined) {
    const file = process.env.M365_TURN_LOG;
    const append = file ? createPrivateAppender(file) : null;
    envTurnLog = append ? (entry) => append(`${redact(JSON.stringify(entry))}\n`) : null;
  }
  return envTurnLog;
}

async function runTurn(
  request: IncomingMessage,
  response: ServerResponse,
  context: Context,
  settings: RequestSettings,
  body: ChatRequest,
  conversation: Conversation,
  model: ReturnType<typeof resolveModel>,
  tools: ToolDef[],
  offered: readonly string[],
  sessionId: string | undefined,
  recorder: TurnRecorder,
  catalog: CodeModeCatalog | undefined,
  requested: readonly ToolDef[],
): Promise<void> {
  // The pool's restart check ran before we queued; re-run it now that the previous
  // turn has recorded what it sent.
  if (body.messages.length < conversation.sentMessageCount) conversation.sentMessageCount = 0;
  conversation.session ??= new CopilotSession({
    getToken: context.deps.getToken,
    ...(context.deps.endpoint ? { endpoint: context.deps.endpoint } : {}),
  });

  // Every tools-derived decision below reads `effectiveTools`. (Upstream emptied it
  // for mailbox-grounded models, which this fork removes.)
  const effectiveTools = tools;
  const workIq = settings.workIq;
  // With the MCP tool search on: OpenCode's Code Mode catalogue, which the proxy
  // searches itself. A parsed reply may name any tool but `mcp`, which is the proxy's
  // own; `execute` reaches opencode only as the proxy's translation of an `mcp` call.
  const mcp = catalog;
  const clientTools = mcp ? effectiveTools.filter((tool) => tool.function.name !== MCP_TOOL_NAME) : effectiveTools;
  const executeName = requested.find(isExecute)?.function.name ?? EXECUTE_TOOL_NAME;

  const note = effectiveTools.length > 0 && conversation.sentMessageCount > 0 ? conversation.note : undefined;
  conversation.note = undefined;
  // Only the messages this turn carries: M365 already has any earlier image.
  const images = collectImages(body.messages, conversation.sentMessageCount);
  const route = toolRouteFor(model.tone);
  const prompt = buildTurnPrompt(mcp ? relabelProxyCalls(body.messages) : body.messages, effectiveTools, conversation.sentMessageCount, {
    framing: route.framing,
    ...(route.sandbox ? { sandbox: route.sandbox } : {}),
    ...(settings.leanSystemPrompt !== undefined ? { leanSystemPrompt: settings.leanSystemPrompt } : {}),
    ...(note ? { note } : {}),
    // A past call may name a tool this turn's tool block leaves out.
    ...(effectiveTools.length > 0 ? { historyTools: [...effectiveTools, ...requested] } : {}),
    ...(mcp ? { renderCall: renderProxyCall } : {}),
  });

  if (recorder.watching) recordRequest(recorder, body, conversation, model, effectiveTools, offered, sessionId, images.length, prompt, mcp);

  const abort = new AbortController();
  request.on("close", () => {
    if (!response.writableEnded) abort.abort();
  });

  const streaming = body.stream === true;
  const streamId = `chatcmpl-${randomUUID()}`;
  // Only a tool-less turn can stream: a fenced tool call is not parseable until the
  // fence closes, so a tool turn has to be buffered and emitted at the end. Under the
  // `hold` Work IQ policy nothing streams either: the evidence that a reply drew on
  // work data can arrive with its last frame, after the text would have gone out.
  const canStreamText = streaming && effectiveTools.length === 0 && workIq !== "hold";

  if (streaming) startSse(response);

  const turnLog = context.deps.turnLog ?? defaultTurnLog();
  const logTurn = (fields: Partial<TurnLogEntry>) =>
    turnLog?.({
      time: new Date().toISOString(),
      model: model.id,
      tone: model.tone,
      ...(effectiveTools.length > 0 ? { framing: route.framing } : {}),
      tools: effectiveTools.map((tool) => tool.function.name),
      ...fields,
    });

  const turnOptions = {
    ...(model.tone ? { tone: model.tone } : {}),
    ...(settings.webSearch ? { webSearch: true } : {}),
    signal: abort.signal,
  };
  // The whole context opencode sent, as it sent it: its context meter wants that size.
  const promptTokens = estimatePromptTokens(body.messages, body.tools);
  const recordTurn = (result: TurnResult, extra: Partial<TurnLogEntry> = {}) => {
    if (sessionId) {
      context.metrics.recordTurn(sessionId, {
        model,
        contextTokens: promptTokens,
        ...(result.throttle ? { throttle: result.throttle } : {}),
        ...(result.metering ? { metering: result.metering } : {}),
      });
    }
    logTurn({
      reply: result.text,
      toolCalls: parseToolCalls(result.text, effectiveTools).toolCalls.map((call) => call.name),
      ...(result.contentOrigin ? { contentOrigin: result.contentOrigin } : {}),
      ...(result.turnCount !== undefined ? { turnCount: result.turnCount } : {}),
      ...(result.throttle ? { throttle: result.throttle } : {}),
      ...(result.scores ? { scores: result.scores } : {}),
      ...(result.resultValue ? { resultValue: result.resultValue } : {}),
      ...extra,
    });
  };

  // The Copilot messages this request sends: opencode's, then any follow-up or answer
  // to an `mcp` search, numbered for the monitor.
  let attempt = 1;
  let logged: Partial<TurnLogEntry> = {};
  try {
    let started = Date.now();
    let result = await conversation.session.run(prompt, {
      ...turnOptions,
      observer: recorder.observer(attempt, false),
      ...(images.length > 0 ? { images } : {}),
      ...(canStreamText
        ? { onDelta: (chunk: string) => response.write(streamChunk(streamId, model.id, { content: chunk })) }
        : {}),
    });
    recorder.reply(attempt, result, Date.now() - started);

    // A tool turn answered with "I have no tools" is a stochastic give-up, not an
    // answer: ask once more in the same conversation, which costs a message but
    // not a new conversation.
    if (
      effectiveTools.length > 0 &&
      parseToolCalls(result.text, effectiveTools).toolCalls.length === 0 &&
      looksLikeGiveUp(result.text)
    ) {
      recordTurn(result);
      recorder.check(
        "give-up",
        "info",
        "Copilot said it could not act on the files instead of taking a step. The gateway asked once more, in the same conversation.",
      );
      const midTask = body.messages.some((message) => message.role === "tool");
      attempt += 1;
      started = Date.now();
      result = await conversation.session.run(nudgeFor(midTask, route.framing), { ...turnOptions, observer: recorder.observer(attempt, true) });
      recorder.reply(attempt, result, Date.now() - started);
      logged = { nudged: true };
    }

    // An `mcp` block: a search is answered here, in the same conversation — one extra
    // M365 message, not a new conversation — and so is a path that is not a tool or a
    // block that cannot be read. Capped, so a model that keeps asking cannot spend the
    // request. A call to a real tool becomes an `execute` call for opencode to run.
    let proxyCall: ParsedToolCall | undefined;
    for (let answered = 0; mcp; ) {
      if (parseToolCalls(result.text, effectiveTools).toolCalls[0]?.name !== MCP_TOOL_NAME) break;
      const ask = parseMcpBlock(firstFenceBody(result.text, MCP_TOOL_NAME) ?? "");

      let answer: string;
      let summary: string;
      let next: Partial<TurnLogEntry> = {};
      if (ask.kind === "call") {
        const path = resolveCallPath(ask.path, mcp.tools, mcp.partial);
        if (path) {
          proxyCall = { name: executeName, arguments: { code: callCode(path, ask.args) } };
          logged = { ...logged, mcpCall: path };
          recorder.check("mcp", "info", `Copilot asked to run the MCP tool ${path}. The gateway passed it to OpenCode as an ${executeName} call, for OpenCode to run.`);
          break;
        }
        answer = renderUnknownTool(ask.path);
        summary = `Copilot asked for an MCP tool OpenCode does not list (${ask.path}). The gateway told it so.`;
      } else if (ask.kind === "search") {
        const matches = searchCatalog(ask.query, mcp.tools);
        if (matches.length === 0 && mcp.partial) {
          // opencode knows tools its catalogue leaves out: ask its own search.
          proxyCall = { name: executeName, arguments: { code: searchCode(ask.query) } };
          logged = { ...logged, mcpCall: "search" };
          recorder.check("mcp", "info", `Copilot searched your MCP tools for "${ask.query}". OpenCode's list had no match, so the gateway passed the search to OpenCode.`);
          break;
        }
        answer = renderSearchResult(ask.query, matches, mcp.tools.length);
        summary = `Copilot searched your MCP tools for "${ask.query}". The gateway answered from OpenCode's list with ${matches.length === 1 ? "1 tool" : `${matches.length} tools`}: names, descriptions and arguments.`;
        next = { mcpSearch: ask.query };
      } else {
        answer = renderInvalidMcpBlock(ask.reason);
        summary = "Copilot wrote an mcp block the gateway could not read. The gateway told it what was wrong.";
      }

      if (answered >= MAX_MCP_SEARCHES) {
        recorder.check("mcp", "info", `Copilot kept using the mcp tool after ${MAX_MCP_SEARCHES} answers, so the gateway stopped answering and sent OpenCode the reply's text.`);
        break;
      }
      answered += 1;
      recordTurn(result, logged);
      recorder.check("mcp", "info", `${summary} That is one more message to Copilot, in the same conversation.`);
      attempt += 1;
      started = Date.now();
      result = await conversation.session.run(answer, { ...turnOptions, observer: recorder.observer(attempt, false, true) });
      recorder.reply(attempt, result, Date.now() - started);
      logged = next;
    }
    recordTurn(result, logged);
    if (mcp && !proxyCall) result = { ...result, text: stripMcpCalls(result.text) };

    // Work IQ: did Copilot search or cite anything to write this? Checked before the
    // reply goes anywhere, so a held reply never reaches opencode.
    const grounding = recorder.grounding();
    const judgement = judgeGrounding(grounding, workIq, settings.webSearch);
    if (judgement) {
      const summary = describeGrounding(grounding);
      recorder.check("work-data", judgement.verdict, summary, grounding.signals);
      if (judgement.hold) throw new WorkDataHeldError(summary);
    }

    // +1 for the reply the client is about to append to its history: M365 already
    // has that turn, and sending it back would paste its own answer in as user input.
    conversation.sentMessageCount = body.messages.length + 1;
    const allowMultiple = context.deps.allowMultiTool ?? false;
    const parsed = proxyCall
      ? { toolCalls: [proxyCall], text: "", skippedCalls: 0, inventedResult: false }
      : parseToolCalls(result.text, clientTools, { allowMultiple });
    conversation.note = noteAbout(parsed);
    if (recorder.watching) {
      recorder.result({
        toolCalls: parsed.toolCalls.map((call) => ({ name: call.name, arguments: JSON.stringify(call.arguments, null, 2) })),
        text: parsed.text,
        skippedCalls: parsed.skippedCalls,
        inventedResult: parsed.inventedResult,
        ...(conversation.note ? { note: conversation.note } : {}),
        streamed: canStreamText,
      });
    }

    if (!streaming) {
      sendJson(
        response,
        200,
        buildCompletion(result, {
          model: model.id,
          tools: clientTools,
          allowMultiple,
          promptTokens,
          ...(proxyCall ? { toolCalls: [proxyCall] } : {}),
        }),
      );
      return;
    }

    finishStream(response, streamId, model.id, parsed, canStreamText, {
      ...(body.stream_options?.include_usage ? { usage: { result, promptTokens } } : {}),
    });
  } catch (error) {
    logTurn({ error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    const refusal =
      error instanceof PriorityAccessExhaustedError ? "allowance" : error instanceof PremiumLicenceRequiredError ? "licence" : undefined;
    if (sessionId && refusal) context.metrics.recordRefusal(sessionId, { model, reason: refusal, message: (error as Error).message });
    if (error instanceof DisengagedError || error instanceof WorkDataHeldError) {
      // A disengaged conversation stays disengaged, and a held one holds work data in
      // Copilot's context. Drop it, so the next request opens a fresh one and replays
      // the whole history into it.
      conversation.session.reset();
      conversation.sentMessageCount = 0;
      recorder.check(
        "conversation",
        "info",
        `${error instanceof DisengagedError ? "Copilot disengaged" : "The reply was held"}, so the gateway dropped this Copilot conversation. The next request opens a fresh one and replays the history.`,
      );
    }
    recorder.error(failureCode(error), error instanceof Error ? error.message : String(error));
    handleTurnFailure(response, error, streaming, effectiveTools.length);
  }
}

/** The monitor's view of opencode's request, and the checks that run before sending. */
function recordRequest(
  recorder: TurnRecorder,
  body: ChatRequest,
  conversation: Conversation,
  model: ReturnType<typeof resolveModel>,
  tools: readonly ToolDef[],
  offered: readonly string[],
  sessionId: string | undefined,
  images: number,
  prompt: string,
  mcp: CodeModeCatalog | undefined,
): void {
  const kept = tools.map((tool) => tool.function.name);
  recorder.request({
    conversation: conversation.key.slice(0, 14),
    ...(sessionId ? { session: sessionId } : {}),
    model: model.id,
    tone: model.tone,
    stream: body.stream === true,
    total: body.messages.length,
    alreadySent: conversation.sentMessageCount,
    messages: summarizeMessages(body.messages.slice(conversation.sentMessageCount), body.messages),
    toolsOffered: [...offered],
    toolsKept: kept,
    images,
  });
  const keptNames = new Set(kept);
  // With the MCP tool search on, `execute` is replaced rather than left out.
  const dropped = offered.filter((name) => !keptNames.has(name) && !(mcp && name.toLowerCase() === EXECUTE_TOOL_NAME));
  if (dropped.length > 0) {
    recorder.check(
      "tools",
      "info",
      `OpenCode offered ${offered.length} tools and the gateway passed on ${kept.length - (mcp ? 1 : 0)} of them, because Copilot stops engaging when it is offered a dozen or so. Left out: ${dropped.join(", ")}.`,
    );
  }
  if (mcp) {
    const count = mcp.partial ? `at least ${mcp.tools.length}` : String(mcp.tools.length);
    recorder.check(
      "mcp",
      "info",
      `MCP tool search is on: Copilot got one mcp tool in place of OpenCode's execute tool and its list of ${count} MCP tools. Copilot sees a tool's name, description and arguments only when it searches for it.`,
    );
  }
  if (conversation.session?.turnIndex === 0) {
    recorder.check(
      "conversation",
      "info",
      "This turn opens a new Copilot conversation, so the gateway sends the whole history. Microsoft throttles accounts that start conversations quickly.",
    );
  }
  recorder.scanOutgoing(prompt);
}

/** The code each failure reaches opencode with; the monitor shows the same one. */
function failureCode(error: unknown): string {
  if (error instanceof AuthRequiredError) return "authentication_required";
  if (error instanceof DisengagedError) return "m365_disengaged";
  if (error instanceof M365ThrottledError) return "m365_throttled";
  if (error instanceof M365UnavailableError) return "m365_not_served";
  if (error instanceof TurnRejectedError) return "m365_turn_rejected";
  if (error instanceof WorkDataHeldError) return "m365_work_data_held";
  if ((error as Error)?.name === "AbortError") return "cancelled";
  return "upstream_error";
}

/**
 * One line for the next turn when the last reply was not run as written. Without
 * it the model assumes every block it wrote ran, and the reference project measured
 * early "task already complete" endings falling from 9 in 56 runs to 0 in 70 once
 * it was told.
 */
export function noteAbout(parsed: { toolCalls: { name: string }[]; skippedCalls: number; inventedResult: boolean }): string | undefined {
  const first = parsed.toolCalls[0];
  if (!first) return undefined;
  const lines: string[] = [];
  if (parsed.skippedCalls > 0) {
    const others = parsed.skippedCalls === 1 ? "1 other" : `${parsed.skippedCalls} others`;
    lines.push(`Only the first tool call in your last reply (${first.name}) ran; the ${others} did not run. Send any that are still needed, one per reply.`);
  }
  if (parsed.inventedResult) lines.push("The result you predicted after your call was set aside; the real one is below.");
  return lines.length > 0 ? lines.join(" ") : undefined;
}

/**
 * Drop every `mcp` block from a reply. Past the search cap the client gets the
 * reply's prose (and any real call in it), never a call to the proxy's own tool.
 */
export function stripMcpCalls(text: string): string {
  const stripped = text.replace(MCP_FENCE, "");
  // A reply with no `mcp` block is left exactly as M365 wrote it.
  return stripped === text ? text : stripped.replace(/\n{3,}/g, "\n\n").trim();
}

const MCP_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*mcp(?![\w-])[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$\n?/gim;

/**
 * opencode 2's Code Mode catalogue for a request, when the proxy should stand in for
 * it: the system prompt carries one, and the request offers `execute` to run calls.
 */
function mcpCatalogFor(body: ChatRequest, requested: readonly ToolDef[]): CodeModeCatalog | undefined {
  if (!requested.some(isExecute)) return undefined;
  const systemText = body.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map(contentOf)
    .join("\n\n");
  const catalog = parseCodeModeCatalog(systemText);
  return catalog && (catalog.tools.length > 0 || catalog.partial) ? catalog : undefined;
}

/** The code of an `execute` call's raw arguments, if it has one. */
function executeCode(rawArguments: string): string | undefined {
  try {
    const args: unknown = JSON.parse(rawArguments || "{}");
    const code = (args as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Name the proxy's own `execute` calls `mcp` in the history, so they replay as the
 * `mcp` blocks the model wrote and their results are labelled as the `mcp` tool's.
 * Any other `execute` call is left as it is.
 */
function relabelProxyCalls(messages: ChatRequest["messages"]): ChatRequest["messages"] {
  return messages.map((message) => {
    if (!message.tool_calls?.some((call) => call.function.name.toLowerCase() === EXECUTE_TOOL_NAME)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map((call) =>
        call.function.name.toLowerCase() === EXECUTE_TOOL_NAME && executeCodeToMcp(executeCode(call.function.arguments))
          ? { ...call, function: { ...call.function, name: MCP_TOOL_NAME } }
          : call,
      ),
    };
  });
}

/** A relabelled call, written back as its `mcp` block. */
function renderProxyCall(name: string, rawArguments: string): string | undefined {
  if (name !== MCP_TOOL_NAME) return undefined;
  const request = executeCodeToMcp(executeCode(rawArguments));
  return request ? renderMcpFence(request) : undefined;
}

/** Emit the closing frames of a streamed turn. */
function finishStream(
  response: ServerResponse,
  streamId: string,
  model: string,
  parsed: { toolCalls: readonly ParsedToolCall[]; text: string },
  alreadyStreamedText: boolean,
  options: { usage?: { result: TurnResult; promptTokens: number } } = {},
): void {
  const { toolCalls, text } = parsed;
  const openAiCalls = toolCalls.length > 0 ? toolCalls.map(toOpenAiToolCall) : undefined;

  if (openAiCalls) {
    response.write(streamChunk(streamId, model, { toolCalls: openAiCalls }));
    response.write(streamChunk(streamId, model, { finishReason: "tool_calls" }));
  } else {
    // If we streamed deltas the client already has the text; sending it again would
    // duplicate the answer.
    if (!alreadyStreamedText && text) response.write(streamChunk(streamId, model, { content: text }));
    response.write(streamChunk(streamId, model, { finishReason: "stop" }));
  }

  // Asked for with `stream_options.include_usage`, which opencode sends by default.
  if (options.usage) {
    const { result, promptTokens } = options.usage;
    const completionTokens = estimateCompletionTokens(openAiCalls ? null : text, openAiCalls);
    response.write(streamUsageChunk(streamId, model, buildUsage(result, { promptTokens, completionTokens })));
  }

  response.write(streamDone());
  response.end();
}

/** opencode retries a 5xx several times and a 4xx not at all (measured on 2.2.5). */
const NON_RETRYABLE = 422;

function handleTurnFailure(response: ServerResponse, error: unknown, streaming: boolean, toolCount: number): void {
  if (error instanceof AuthRequiredError) {
    finishWithError(response, streaming, 401, "authentication_required", error.message);
    return;
  }

  if (error instanceof DisengagedError) {
    // Empty content makes this look like rate limiting. It is not, and retrying just
    // disengages again while burning the 600-message conversation quota.
    const hint =
      toolCount >= 12
        ? ` The request carried ${toolCount} tools; M365 disengages persistently above roughly 12. Reduce the toolset — see the lean profile in the opencode plugin.`
        : " M365 refused to engage with this prompt. The next request starts a fresh conversation with the whole history; if that disengages too, reduce the toolset or simplify the prompt.";
    refuse(response, streaming, "m365_disengaged", `M365 Copilot disengaged.${hint}`);
    return;
  }

  if (error instanceof M365ThrottledError) {
    refuse(response, streaming, "m365_throttled", error.message);
    return;
  }

  if (error instanceof M365UnavailableError) {
    refuse(response, streaming, "m365_not_served", error.message, error.reason);
    return;
  }

  if (error instanceof TurnRejectedError) {
    refuse(response, streaming, "m365_turn_rejected", error.message);
    return;
  }

  if (error instanceof WorkDataHeldError) {
    refuse(response, streaming, "m365_work_data_held", error.message);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  if ((error as Error)?.name === "AbortError") {
    if (!response.writableEnded) response.end();
    return;
  }

  finishWithError(response, streaming, 502, "upstream_error", message);
}

/**
 * Report an M365 refusal so that opencode does not retry it.
 *
 * opencode streams, so the refusal reaches it inside a stream that already answered
 * 200, and it decides from the body alone (measured against 2.2.5's classifier, see
 * test/opencode-retry.ts). It retries a code containing "unavailable", a message
 * saying "try again" — which M365's own refusals do — and any mention of a rate
 * limit. Type `invalid_request_error` switches off the "try again" rule; the rate
 * limit wording is reworded, since that rule ignores the type.
 */
function refuse(response: ServerResponse, streaming: boolean, code: string, message: string, param?: string): void {
  const reworded = message
    .replace(/rate increased too quickly/gi, "sent too fast")
    .replace(/rate[-_\s]?limit/gi, "throttle")
    .replace(/too[_\s]?many[_\s]?requests/gi, "too many turns");
  finishWithError(response, streaming, NON_RETRYABLE, code, reworded, "invalid_request_error", param);
}

/** Report an error, in whichever shape the client is already reading. */
function finishWithError(
  response: ServerResponse,
  streaming: boolean,
  status: number,
  code: string,
  message: string,
  type: string = code,
  param?: string,
): void {
  // `param` says which refusal it was, for a client that wants to act on it.
  const error = { message, type, code, ...(param ? { param } : {}) };
  if (!streaming) {
    if (!response.writableEnded) sendJson(response, status, { error });
    return;
  }
  // Headers are already out on a stream; the error has to ride in the body.
  if (!response.writableEnded) {
    response.write(`data: ${JSON.stringify({ error })}\n\n`);
    response.write(streamDone());
    response.end();
  }
}

function respondWithTitle(response: ServerResponse, body: ChatRequest, model: string): string {
  const title = generateTitle(body.messages);

  if (body.stream !== true) {
    sendJson(response, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
      usage: buildUsage({ text: title }),
    });
    return title;
  }

  const streamId = `chatcmpl-${randomUUID()}`;
  startSse(response);
  response.write(streamChunk(streamId, model, { content: title }));
  response.write(streamChunk(streamId, model, { finishReason: "stop" }));
  response.write(streamDone());
  response.end();
  return title;
}

// --- plumbing -------------------------------------------------------------------

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.writableEnded) return;
  sendJson(response, status, { error: { message, type: code, code } });
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError(`Request body exceeds ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new PayloadTooLargeError(`Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export { DEFAULT_MODEL };
