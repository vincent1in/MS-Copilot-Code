/**
 * One turn's recorder: the bridge between the request handler and the monitor.
 *
 * It always collects Work IQ evidence, because the policy needs it whether or not
 * anyone is watching; it only builds and emits monitor events when a monitor is
 * attached, so a gateway with the monitor off pays for nothing but the grounding scan.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../translate.js";
import { contentOf } from "../translate.js";
import type { SentFrame, TurnObserver, TurnResult } from "../session.js";
import {
  signalsFromAttributions,
  signalsFromControl,
  summarizeGrounding,
  type GroundingReport,
  type GroundingSignal,
} from "../workiq.js";
import type { CheckName, GroundingKind, MonitorEventBody, MonitorMessage, Verdict } from "./events.js";
import type { Monitor } from "./monitor.js";
import { findSecrets } from "./secrets.js";

type RequestFields = Omit<Extract<MonitorEventBody, { kind: "request" }>, "kind" | "turn">;
type ResultFields = Omit<Extract<MonitorEventBody, { kind: "result" }>, "kind" | "turn">;

export class TurnRecorder {
  readonly id = randomUUID();
  private readonly signals: GroundingSignal[] = [];
  private readonly attemptSignals = new Map<number, GroundingSignal[]>();

  constructor(private readonly monitor: Monitor | undefined) {}

  get watching(): boolean {
    return this.monitor !== undefined;
  }

  request(fields: RequestFields): void {
    this.monitor?.emit({ kind: "request", turn: this.id, ...fields });
  }

  check(check: CheckName, verdict: Verdict, summary: string, detail?: unknown): void {
    this.monitor?.emit({ kind: "check", turn: this.id, check, verdict, summary, ...(detail !== undefined ? { detail } : {}) });
  }

  /** Flag anything credential-shaped in text about to go to Copilot. Monitor only. */
  scanOutgoing(text: string): void {
    if (!this.monitor) return;
    const findings = findSecrets(text);
    if (findings.length === 0) return;
    const first = findings[0]!;
    const more = findings.length > 1 ? ` and ${findings.length - 1} more` : "";
    this.check(
      "secrets",
      "flagged",
      `The text going to Copilot contains something that looks like a ${first.kind} (line ${first.line})${more}. It is sent as is; the gateway does not alter prompts.`,
      findings,
    );
  }

  /** The observer for one Copilot attempt: collects grounding evidence, and records when watched. */
  observer(attempt: number, nudge: boolean): TurnObserver {
    const signals: GroundingSignal[] = [];
    this.attemptSignals.set(attempt, signals);
    const collect = (found: GroundingSignal[]) => {
      signals.push(...found);
      this.signals.push(...found);
    };
    return {
      sent: (frame: SentFrame) => {
        if (!this.monitor) return;
        const message = frame.argument.message as Record<string, unknown> | undefined;
        this.monitor.emit({
          kind: "send",
          turn: this.id,
          attempt,
          nudge,
          host: frame.host,
          path: frame.path,
          params: frame.params,
          text: typeof message?.text === "string" ? message.text : "",
          envelope: message ? { ...frame.argument, message: { ...message, text: "(the text is shown separately)" } } : frame.argument,
        });
      },
      control: (message) => {
        const found = signalsFromControl(message);
        collect(found);
        if (!this.monitor) return;
        const text = [message.text, message.hiddenText].find((part): part is string => typeof part === "string" && part.trim() !== "") ?? "";
        const hosts = found.map((signal) => signal.host).filter((host): host is string => Boolean(host));
        const grounding = strongest(found);
        this.monitor.emit({
          kind: "activity",
          turn: this.id,
          attempt,
          type: String(message.messageType),
          text,
          ...(grounding ? { grounding } : {}),
          ...(hosts.length > 0 ? { hosts } : {}),
        });
      },
      sources: (attributions) => collect(signalsFromAttributions(attributions)),
    };
  }

  reply(attempt: number, result: TurnResult, ms: number): void {
    if (!this.monitor) return;
    const sources = (this.attemptSignals.get(attempt) ?? [])
      .filter((signal) => signal.via === "source")
      .map((signal) => ({ host: signal.host ?? "", kind: signal.kind, ...(signal.label !== signal.host ? { title: signal.label } : {}) }));
    this.monitor.emit({
      kind: "reply",
      turn: this.id,
      attempt,
      text: result.text,
      ms,
      ...(result.contentOrigin ? { contentOrigin: result.contentOrigin } : {}),
      ...(result.turnCount !== undefined ? { turnCount: result.turnCount } : {}),
      ...(result.throttle ? { throttle: result.throttle } : {}),
      ...(result.scores ? { scores: result.scores } : {}),
      ...(result.resultValue ? { resultValue: result.resultValue } : {}),
      ...(sources.length > 0 ? { sources } : {}),
    });
  }

  result(fields: ResultFields): void {
    this.monitor?.emit({ kind: "result", turn: this.id, ...fields });
  }

  error(code: string, message: string): void {
    this.monitor?.emit({ kind: "error", turn: this.id, code, message });
  }

  /** Everything Copilot searched or cited across this turn's attempts. */
  grounding(): GroundingReport {
    return summarizeGrounding(this.signals);
  }
}

/** opencode's new messages, as the monitor shows them. */
export function summarizeMessages(messages: readonly ChatMessage[], history: readonly ChatMessage[]): MonitorMessage[] {
  const callNames = new Map<string, string>();
  for (const message of history) {
    for (const call of message.tool_calls ?? []) callNames.set(call.id, call.function.name);
  }
  return messages.map((message) => {
    const images = Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url").length : 0;
    const toolName = message.role === "tool" && message.tool_call_id ? callNames.get(message.tool_call_id) : undefined;
    return {
      role: message.role,
      text: contentOf(message),
      ...(message.tool_calls?.length
        ? { toolCalls: message.tool_calls.map((call) => ({ name: call.function.name, arguments: call.function.arguments })) }
        : {}),
      ...(toolName ? { toolName } : {}),
      ...(images > 0 ? { images } : {}),
    };
  });
}

function strongest(signals: readonly GroundingSignal[]): GroundingKind | undefined {
  const verdict = summarizeGrounding(signals).verdict;
  return verdict === "none" ? undefined : verdict;
}
