import { LOG_FILE } from "./paths.js";
import { createPrivateAppender } from "./private-fs.js";

const DEBUG = process.env.M365_DEBUG === "1" || process.env.M365_TRACE === "1";
const TRACE = process.env.M365_TRACE === "1";
const TO_STDOUT = process.env.M365_LOG_STDOUT === "1";

/**
 * One appender for every scope, since they all share the file. Owner-only (under
 * M365_TRACE this log carries the access token), with the mkdir and chmods paid on
 * the first line only — this runs per stream delta on opencode's event loop.
 */
const appendLog = createPrivateAppender(LOG_FILE);

/**
 * Credentials that must never reach a log line, whatever is being logged: token
 * parameters in URLs and form bodies (including the sign-in redirect's `code`), bearer
 * headers, token fields in JSON (also JSON-escaped, e.g. inside a turn-log `reply`, and
 * camelCase), and JWT/JWE-shaped strings (every Entra access token is one). Applied to
 * every line, including under M365_TRACE and in the M365_TURN_LOG file.
 *
 * Every pattern is linear-time: each can only start at a token boundary (anchored by a
 * preceding delimiter or a lookbehind) and has no nested or overlapping quantifiers.
 * These run synchronously on opencode's event loop over model output, so a quadratic
 * pattern is a denial of service (an unanchored JWT pattern took 31 s on 200 KB).
 */
const TOKEN_PARAMS = "access_token|refresh_token|id_token|client_info|client_secret|code_verifier|assertion";
const TOKEN_FIELDS =
  "access_token|refresh_token|id_token|client_info|client_secret|secret|code_verifier|accessToken|refreshToken|idToken|clientInfo|clientSecret";
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(`((?:^|[?&#;\\s"'])(?:${TOKEN_PARAMS})=)[^&\\s"'<>]+`, "gi"), "$1[REDACTED]"],
  [/([?&#](?:code|session_state)=)[^&\s"'<>]+/gi, "$1[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [new RegExp(`(?<=")((?:${TOKEN_FIELDS})\\\\{0,6}"\\s*:\\s*\\\\{0,6}")[^"\\\\]*`, "g"), "$1[REDACTED]"],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){1,4}/g, "[REDACTED_JWT]"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** Truncate a payload for the log unless full tracing is on. */
export function trunc(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (TRACE || text == null) return String(text);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

export interface Logger {
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

/**
 * A file logger, off unless `M365_DEBUG=1`.
 *
 * The plugin runs inside opencode's server process, so writing to stdout would
 * corrupt the TUI. Everything goes to a file unless explicitly asked otherwise.
 */
export function createLogger(scope: string): Logger {
  const write = (level: string, parts: unknown[]) => {
    if (!DEBUG) return;
    const line = redact(`${new Date().toISOString()} [${level}] [${scope}] ${parts.map((p) => trunc(p)).join(" ")}`);
    if (TO_STDOUT) process.stdout.write(`${line}\n`);
    try {
      appendLog(`${line}\n`);
    } catch {
      /* logging must never take the caller down */
    }
  };

  return {
    info: (...parts) => write("info", parts),
    warn: (...parts) => write("warn", parts),
    error: (...parts) => write("error", parts),
  };
}
