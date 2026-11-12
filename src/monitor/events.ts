/**
 * What the gateway monitor records: one event per step of a turn, plus the checks the
 * gateway ran along the way. The browser page (`ui/monitor.js`) reads exactly these
 * shapes, so a change here is a change there.
 *
 * A *turn* is one request from opencode. It may take two Copilot attempts (the second
 * being the follow-up sent after a give-up), so the per-attempt events carry `attempt`.
 */

export type GroundingKind = "work" | "web" | "unknown";

/** A message from opencode's request that Copilot had not seen yet. */
export interface MonitorMessage {
  role: string;
  text: string;
  /** Calls an assistant message carried (history replayed into a fresh conversation). */
  toolCalls?: { name: string; arguments: string }[];
  /** For a tool result: which tool produced it. */
  toolName?: string;
  images?: number;
}

export type CheckName =
  | "egress"
  | "work-data"
  | "secrets"
  | "give-up"
  | "tools"
  | "refusal"
  | "conversation";

export type Verdict = "allowed" | "denied" | "held" | "flagged" | "info";

/** The gateway's settings, as the page's header shows them. Sent once per connection. */
export interface GatewayFacts {
  /** Where opencode reaches the proxy. The proxy's secret is never recorded. */
  proxy: string;
  pid: number;
  defaultModel: string;
  webSearch: boolean;
  studioAgent: boolean;
  lean: boolean;
  workIq: string;
  startedAt: string;
}

export type MonitorEventBody =
  | {
      kind: "request";
      turn: string;
      /** The pool key: a hash of the opencode session id, or of the opening messages. */
      conversation: string;
      /** opencode's session id, when it sent one. */
      session?: string;
      model: string;
      tone: string | null;
      stream: boolean;
      /** Messages in opencode's request, and how many of them Copilot already has. */
      total: number;
      alreadySent: number;
      messages: MonitorMessage[];
      toolsOffered: string[];
      toolsKept: string[];
      images: number;
    }
  | {
      kind: "send";
      turn: string;
      attempt: number;
      /** The follow-up after a give-up, rather than opencode's own request. */
      nudge: boolean;
      host: string;
      path: string;
      /** The connection's query parameters, without the access token. */
      params: Record<string, string>;
      /** Exactly the text Copilot received. */
      text: string;
      /** The rest of the chat request, with `message.text` elided (it is `text`). */
      envelope: unknown;
    }
  | {
      kind: "activity";
      turn: string;
      attempt: number;
      /** M365's `messageType`: InternalSearchQuery, Progress, RenderCardRequest, … */
      type: string;
      text: string;
      grounding?: GroundingKind;
      hosts?: string[];
    }
  | {
      kind: "reply";
      turn: string;
      attempt: number;
      /** Copilot's answer, verbatim. */
      text: string;
      ms: number;
      contentOrigin?: string;
      turnCount?: number;
      throttle?: { current: number; max: number };
      scores?: Record<string, number>;
      resultValue?: string;
      sources?: { host: string; kind: GroundingKind; title?: string }[];
    }
  | {
      kind: "result";
      turn: string;
      /** What opencode received: tool calls to run, or text. */
      toolCalls: { name: string; arguments: string }[];
      text: string;
      skippedCalls: number;
      inventedResult: boolean;
      /** Told to Copilot on the next turn, when its last reply was not run as written. */
      note?: string;
      streamed: boolean;
    }
  | {
      kind: "check";
      turn?: string;
      check: CheckName;
      verdict: Verdict;
      summary: string;
      detail?: unknown;
    }
  | { kind: "error"; turn: string; code: string; message: string }
  | { kind: "title"; model: string; title: string }
  | { kind: "cleared" };

export type MonitorEvent = MonitorEventBody & { seq: number; at: string };
