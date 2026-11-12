/**
 * Spotting text that looks like a credential in what the gateway is about to send.
 *
 * This only flags. The monitor exists to show what really left the machine, so the
 * outgoing text is never altered here; a finding tells the user that something
 * key-shaped was in a prompt that Microsoft now has (a file the agent read, a command's
 * output). It is a heuristic, not a scanner to rely on: it knows a handful of common
 * shapes and will miss anything else.
 *
 * Every pattern is linear in the input: each starts at a boundary (a lookbehind or a
 * line start) and every quantifier is bounded, so no match attempt can backtrack more
 * than a fixed amount. It runs over prompts that can be a megabyte of tool output.
 */

export interface SecretFinding {
  /** What it looks like, in plain words. */
  kind: string;
  /** Offset of the match in the scanned text. */
  index: number;
  length: number;
  /** 1-based line number of the match. */
  line: number;
  /** The first few characters and a mask: enough to find it, not enough to reuse it. */
  preview: string;
}

const PATTERNS: ReadonlyArray<readonly [kind: string, pattern: RegExp]> = [
  ["private key", /-----BEGIN (?:[A-Z0-9]{1,16} ){0,3}PRIVATE KEY-----/g],
  ["signed token (JWT)", /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,8192}/g],
  ["AWS access key", /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])/g],
  ["GitHub token", /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g],
  ["Slack token", /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,200}/g],
  ["Azure storage key", /AccountKey=[A-Za-z0-9+/]{40,120}={0,2}/g],
  ["bearer token", /(?<![A-Za-z0-9])Bearer [A-Za-z0-9._~+/-]{20,4096}={0,2}/g],
  [
    "database URL with a password",
    /(?<![A-Za-z0-9+.-])(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]{1,256}:[^\s@/]{1,256}@/gi,
  ],
  [
    "secret in an env file",
    /^[ \t]{0,16}(?:export[ \t]{1,4})?[A-Z0-9_]{0,64}(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]{0,64}[ \t]{0,4}=[ \t]{0,4}["']?[^\s"']{8,512}/gm,
  ],
];

/** Findings beyond this many are dropped; the first ones are what matter. */
const MAX_FINDINGS = 50;

export function findSecrets(text: string): SecretFinding[] {
  const found: Omit<SecretFinding, "line">[] = [];
  collect: for (const [kind, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // Line-anchored patterns take the indentation too; the finding starts at the text.
      const lead = match[0].length - match[0].trimStart().length;
      found.push({ kind, index: (match.index ?? 0) + lead, length: match[0].length - lead, preview: mask(match[0]) });
      if (found.length >= MAX_FINDINGS) break collect;
    }
  }
  found.sort((a, b) => a.index - b.index);

  // One pass over the text for every line number, rather than one scan per finding.
  const findings: SecretFinding[] = [];
  let line = 1;
  let cursor = 0;
  for (const finding of found) {
    for (let next = text.indexOf("\n", cursor); next !== -1 && next < finding.index; next = text.indexOf("\n", next + 1)) {
      line += 1;
      cursor = next + 1;
    }
    findings.push({ ...finding, line });
  }
  return findings;
}

function mask(value: string): string {
  // A PEM header names the key type and nothing secret; show it whole.
  if (value.startsWith("-----")) return value;
  // An env assignment: the variable's name says what it is; the value stays hidden.
  const assignment = /^[ \t]*(?:export[ \t]+)?([A-Z0-9_]+)[ \t]*=/.exec(value);
  if (assignment) return `${assignment[1]}=…`;
  const visible = Math.min(6, Math.floor(value.length / 4));
  return `${value.slice(0, visible)}…`;
}
