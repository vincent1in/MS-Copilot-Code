/**
 * The gateway monitor's memory: a bounded, in-process log of what each turn sent and
 * received, which the monitor page streams.
 *
 * Temporary by design. Nothing here is written to disk; it lives in this process,
 * is capped by count and by size (oldest out first), and is gone on `clear()` or when
 * the gateway stops.
 *
 * Content is kept verbatim — prompts, replies, tool output — because the point is to
 * see exactly what left the machine. The gateway's own credentials never reach it:
 * emitters leave tokens out (the chat token rides in the WebSocket URL, which is never
 * recorded whole), and as a second line the infrastructure fields listed in
 * {@link REDACTED_FIELDS} are run through the log redactor anyway.
 */

import { redact } from "../log.js";
import type { MonitorEvent, MonitorEventBody } from "./events.js";

export interface MonitorOptions {
  /** Most events kept. */
  maxEvents?: number;
  /** Most characters kept across all events (strings only; a rough memory bound). */
  maxChars?: number;
  /** Longest single string kept; the rest is cut with a note saying so. */
  maxFieldChars?: number;
  now?: () => Date;
}

export interface Monitor {
  emit(event: MonitorEventBody): void;
  /** Everything currently kept, oldest first. */
  snapshot(): MonitorEvent[];
  /** Live events, from now on. Returns the unsubscribe function. */
  subscribe(listener: (event: MonitorEvent) => void): () => void;
  /** Forget everything kept, and tell subscribers to do the same. */
  clear(): void;
  readonly size: number;
}

export const MONITOR_LIMITS = {
  maxEvents: 5_000,
  maxChars: 24_000_000,
  maxFieldChars: 512_000,
} as const;

/** Top-level fields that describe the gateway's plumbing rather than conversation content. */
const REDACTED_FIELDS = new Set(["summary", "detail", "params", "envelope", "proxy"]);
/** On an `error` event, `message` is plumbing too: transport errors can quote a URL. */
const REDACTED_ON_ERROR = new Set(["message"]);

const MAX_DEPTH = 12;

export function createMonitor(options: MonitorOptions = {}): Monitor {
  const maxEvents = options.maxEvents ?? MONITOR_LIMITS.maxEvents;
  const maxChars = options.maxChars ?? MONITOR_LIMITS.maxChars;
  const maxFieldChars = options.maxFieldChars ?? MONITOR_LIMITS.maxFieldChars;
  const now = options.now ?? (() => new Date());

  const kept: { event: MonitorEvent; chars: number }[] = [];
  let keptChars = 0;
  let seq = 0;
  const listeners = new Set<(event: MonitorEvent) => void>();

  const publish = (event: MonitorEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a broken viewer must never break a turn */
      }
    }
  };

  return {
    emit(body) {
      try {
        const counter = { chars: 0 };
        const redactKeys = body.kind === "error" ? new Set([...REDACTED_FIELDS, ...REDACTED_ON_ERROR]) : REDACTED_FIELDS;
        const copy = copyBody(body, redactKeys, maxFieldChars, counter);
        seq += 1;
        const event = { ...copy, seq, at: now().toISOString() } as MonitorEvent;
        kept.push({ event, chars: counter.chars });
        keptChars += counter.chars;
        while (kept.length > maxEvents || (keptChars > maxChars && kept.length > 1)) {
          keptChars -= kept.shift()!.chars;
        }
        publish(event);
      } catch {
        /* recording is best effort; the turn goes on regardless */
      }
    },
    snapshot: () => kept.map((entry) => entry.event),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      kept.length = 0;
      keptChars = 0;
      seq += 1;
      publish({ kind: "cleared", seq, at: now().toISOString() });
    },
    get size() {
      return kept.length;
    },
  };
}

/**
 * A deep copy of an event body, so later mutation by the emitter cannot change what
 * was recorded, with long strings cut and plumbing fields redacted. Counts the
 * characters it keeps.
 */
function copyBody(
  body: MonitorEventBody,
  redactKeys: ReadonlySet<string>,
  maxFieldChars: number,
  counter: { chars: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    out[key] = copyValue(value, redactKeys.has(key), maxFieldChars, counter, 0);
  }
  return out;
}

function copyValue(value: unknown, redacting: boolean, maxFieldChars: number, counter: { chars: number }, depth: number): unknown {
  if (typeof value === "string") {
    const text = cut(redacting ? redact(value) : value, maxFieldChars);
    counter.chars += text.length;
    return text;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[nested too deeply to record]";
  if (Array.isArray(value)) return value.map((item) => copyValue(item, redacting, maxFieldChars, counter, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    counter.chars += key.length;
    out[key] = copyValue(item, redacting, maxFieldChars, counter, depth + 1);
  }
  return out;
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = max.toLocaleString("en-US");
  const total = text.length.toLocaleString("en-US");
  return `${text.slice(0, max)}\n[The monitor kept the first ${kept} of ${total} characters.]`;
}
