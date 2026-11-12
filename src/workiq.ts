/**
 * Work IQ: noticing when Copilot answered a coding turn from your work data.
 *
 * Work IQ is Microsoft's name for Copilot's grounding in Microsoft 365 work data —
 * email, files, chats, meetings, people. In Copilot Chat it is a single on/off button
 * (it replaced the separate Work and Web tabs), offered only with the Microsoft 365
 * Copilot add-on licence and on by default for those users.
 *
 * This gateway never asks for it: it talks to the full-screen Copilot Chat scenario
 * with no plugins, and the mailbox-grounded scenario was removed. Whether the server
 * applies Work IQ to such a turn anyway has not been verified against a live tenant.
 * So instead of trusting the request shape, every turn is checked for evidence that
 * work data was used, and the policy decides what happens to such a reply.
 *
 * Evidence comes only from structured protocol traffic, never from the answer's own
 * words: a reply that mentions a SharePoint URL because your code does is not
 * grounding. The signals are the bot's control messages (`InternalSearchQuery`,
 * `InternalSearchResult`, reference cards) and the answer's `sourceAttributions`.
 * The protocol is undocumented, so classification is by URL host and by the search
 * invocation's name, and anything unrecognised is reported as `unknown`.
 */

import type { GroundingKind } from "./monitor/events.js";

export type WorkIqPolicy = "hold" | "flag" | "allow";

export const WORK_IQ_POLICIES: readonly WorkIqPolicy[] = ["hold", "flag", "allow"];

/** The default: a reply grounded in work data never reaches opencode. */
export const DEFAULT_WORK_IQ_POLICY: WorkIqPolicy = "hold";

export interface GroundingSignal {
  kind: GroundingKind;
  /** Where the evidence came from. */
  via: "search" | "result" | "source";
  /** What it says: a search query, a source title, or a host. */
  label: string;
  host?: string;
}

export interface GroundingReport {
  /** The strongest evidence: work beats unknown beats web. `none` when there was none. */
  verdict: GroundingKind | "none";
  signals: GroundingSignal[];
}

/**
 * Hosts that serve Microsoft 365 tenant content. A source on one of these is work
 * data; any other http(s) host is the public web.
 */
const WORK_HOST_SUFFIXES = [
  "sharepoint.com",
  "sharepoint.us",
  "sharepoint.cn",
  "sharepoint-mil.us",
  "sharepoint-df.com",
  "office.com",
  "office365.com",
  "office.net",
  "cloud.microsoft",
  "microsoft365.com",
  "dynamics.com",
  "powerapps.com",
  "teams.microsoft.com",
  "loop.microsoft.com",
  "graph.microsoft.com",
  "onenote.com",
  "yammer.com",
  "viva.microsoft.com",
];

/**
 * Copilot's own service hosts. A link to one (an uploaded image, a generated file) is
 * Copilot's plumbing, not a source it read, so it says nothing either way.
 */
const SERVICE_HOSTS = new Set(["substrate.office.com"]);

export function classifyHost(host: string): GroundingKind {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (!name || SERVICE_HOSTS.has(name)) return "unknown";
  return WORK_HOST_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`)) ? "work" : "web";
}

const WEB_INVOCATION = /(?:^|[^a-z])(?:web|bing)(?:[^a-z]|$)/i;
const WORK_INVOCATION =
  /enterprise|graph|office|outlook|mail|calendar|meeting|teams|people|person|file|document|onedrive|sharepoint|substrate|work/i;

/**
 * Classify a search by the name of the call M365 says it made (`search_web(...)`,
 * `search_enterprise(...)`). Only that structured name is trusted: the query text is
 * the model's own words about your code, and "read file config.ts" says nothing
 * about where it searched.
 */
export function classifyInvocation(invocation: string | undefined): GroundingKind {
  const name = invocation?.split("(")[0] ?? "";
  if (!name) return "unknown";
  if (WEB_INVOCATION.test(name)) return "web";
  if (WORK_INVOCATION.test(name)) return "work";
  return "unknown";
}

/**
 * Evidence from one bot control message. Returns nothing for traffic that says
 * nothing about grounding (progress notes, suggestions).
 */
export function signalsFromControl(message: { messageType?: unknown; text?: unknown; hiddenText?: unknown; invocation?: unknown; [key: string]: unknown }): GroundingSignal[] {
  const type = typeof message.messageType === "string" ? message.messageType : "";
  if (type === "InternalSearchQuery") {
    const label = firstString(message.text, message.hiddenText) ?? "(no query text)";
    // `invocation` when M365 sends one; a `hiddenText` shaped like a call otherwise.
    const call =
      typeof message.invocation === "string"
        ? message.invocation
        : typeof message.hiddenText === "string" && /^[a-z_][a-z0-9_]{0,63}\(/i.test(message.hiddenText)
          ? message.hiddenText
          : undefined;
    return [{ kind: classifyInvocation(call), via: "search", label }];
  }
  if (type === "InternalSearchResult" || type === "RenderCardRequest" || type === "ReferencesListComplete") {
    const hosts = hostsIn(message);
    if (hosts.length === 0) {
      // A search result with nothing we can place is still a search result.
      return type === "InternalSearchResult" ? [{ kind: "unknown", via: "result", label: "search results with no recognisable source" }] : [];
    }
    return hosts.map((host) => ({ kind: classifyHost(host), via: "result" as const, label: host, host }));
  }
  return [];
}

/** Evidence from an answer's `sourceAttributions`. */
export function signalsFromAttributions(attributions: unknown): GroundingSignal[] {
  if (!Array.isArray(attributions)) return [];
  const signals: GroundingSignal[] = [];
  for (const attribution of attributions.slice(0, 100)) {
    const hosts = hostsIn(attribution);
    const title =
      attribution && typeof attribution === "object"
        ? firstString((attribution as Record<string, unknown>).providerDisplayName, (attribution as Record<string, unknown>).title)
        : undefined;
    if (hosts.length === 0) {
      signals.push({ kind: "unknown", via: "source", label: title ?? "a source with no recognisable link" });
      continue;
    }
    for (const host of hosts) signals.push({ kind: classifyHost(host), via: "source", label: title ?? host, host });
  }
  return signals;
}

export function summarizeGrounding(signals: readonly GroundingSignal[]): GroundingReport {
  const kinds = new Set(signals.map((signal) => signal.kind));
  const verdict: GroundingReport["verdict"] = kinds.has("work") ? "work" : kinds.has("unknown") ? "unknown" : kinds.has("web") ? "web" : "none";
  return { verdict, signals: dedupe(signals) };
}

/** M365 answered from work data and the policy is `hold`: the reply must not reach opencode. */
export class WorkDataHeldError extends Error {
  constructor(summary: string) {
    super(
      `${summary} The gateway held this reply, so none of it reached OpenCode, and the next request starts a fresh Copilot conversation. To let such replies through, open the gateway's page (opencode-m365 start) and change "When Copilot uses your work data" under Settings.`,
    );
    this.name = "WorkDataHeldError";
  }
}

/**
 * What a grounding report means under a policy.
 *
 * - Work data: held under `hold`, flagged under `flag`, noted under `allow`.
 * - A search the gateway cannot place: flagged (never held — it may be harmless).
 * - The web: expected when Bing is on; flagged when it is off, since nothing asked for it.
 */
export function judgeGrounding(
  report: GroundingReport,
  policy: WorkIqPolicy,
  webSearch: boolean,
): { verdict: "held" | "flagged" | "info"; hold: boolean } | undefined {
  if (report.verdict === "none") return undefined;
  if (policy === "allow") return { verdict: "info", hold: false };
  if (report.verdict === "work") return policy === "hold" ? { verdict: "held", hold: true } : { verdict: "flagged", hold: false };
  if (report.verdict === "web" && webSearch) return { verdict: "info", hold: false };
  return { verdict: "flagged", hold: false };
}

/** The policy from the plugin option, else `M365_WORK_IQ`, else hold. */
export function workIqPolicy(options?: { workIq?: unknown }): WorkIqPolicy {
  const fromOption = options?.workIq;
  if (typeof fromOption === "string" && (WORK_IQ_POLICIES as readonly string[]).includes(fromOption)) return fromOption as WorkIqPolicy;
  const fromEnv = process.env.M365_WORK_IQ?.trim().toLowerCase();
  if (fromEnv && (WORK_IQ_POLICIES as readonly string[]).includes(fromEnv)) return fromEnv as WorkIqPolicy;
  return DEFAULT_WORK_IQ_POLICY;
}

/** One line for the monitor and the error opencode shows. */
export function describeGrounding(report: GroundingReport): string {
  const work = report.signals.filter((signal) => signal.kind === "work");
  const unknown = report.signals.filter((signal) => signal.kind === "unknown");
  const web = report.signals.filter((signal) => signal.kind === "web");
  const parts: string[] = [];
  if (work.length > 0) parts.push(`your work data (${listLabels(work)})`);
  if (unknown.length > 0) {
    parts.push(`${unknown.length === 1 ? "a search" : `${unknown.length} searches`} the gateway could not place (${listLabels(unknown)})`);
  }
  if (web.length > 0) parts.push(`the web (${listLabels(web)})`);
  return parts.length > 0 ? `Copilot drew on ${joinAnd(parts)}.` : "Copilot did not search or cite anything.";
}

// --- helpers ----------------------------------------------------------------------

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}]{1,2048}/g;

/** Hosts of every http(s) URL in a value, walked to a bounded depth and size. */
function hostsIn(value: unknown): string[] {
  const hosts = new Set<string>();
  let budget = 400;
  const walk = (node: unknown, depth: number): void => {
    if (budget <= 0 || depth > 8) return;
    if (typeof node === "string") {
      budget -= 1;
      for (const match of node.slice(0, 20_000).matchAll(URL_PATTERN)) {
        try {
          hosts.add(new URL(match[0]).hostname.toLowerCase());
        } catch {
          /* not a URL after all */
        }
        if (hosts.size >= 50) return;
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const item of Array.isArray(node) ? node : Object.values(node)) walk(item, depth + 1);
  };
  walk(value, 0);
  return [...hosts];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function dedupe(signals: readonly GroundingSignal[]): GroundingSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}|${signal.via}|${signal.label}|${signal.host ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function listLabels(signals: readonly GroundingSignal[]): string {
  const labels = [...new Set(signals.map((signal) => (signal.label.length > 60 ? `${signal.label.slice(0, 57)}…` : signal.label)))];
  return labels.length > 3 ? `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more` : labels.join(", ");
}
