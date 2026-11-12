/**
 * Every egress allowlist decision, as a monitor check: what the gateway tried to
 * reach, for what, and whether the allowlist let it. Tied to the running turn when
 * there is one (see `scope.ts`); sign-in refreshes between turns appear on their own.
 */

import { onEgress, type EgressPurpose } from "../egress.js";
import type { Monitor } from "./monitor.js";
import { turnScope } from "./scope.js";

const PURPOSE: Record<EgressPurpose, string> = {
  auth: "Sign-in token request",
  chat: "Copilot connection",
};

export function recordEgress(monitor: Monitor): () => void {
  return onEgress((decision) => {
    const turn = turnScope.getStore();
    const what = `${PURPOSE[decision.purpose] ?? "Request"} to ${decision.host}`;
    const summary = !decision.allowed
      ? `${what} was refused. ${decision.reason ?? ""}`.trim()
      : decision.loopback
        ? `${what} was allowed. It is this machine, so nothing left it.`
        : `${what} was allowed: the host is on the allowlist for this purpose, over TLS on port 443.`;
    monitor.emit({
      kind: "check",
      ...(turn ? { turn } : {}),
      check: "egress",
      verdict: decision.allowed ? "allowed" : "denied",
      summary,
      detail: { purpose: decision.purpose, host: decision.host },
    });
  });
}
