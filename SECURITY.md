# Security

This is a safety-reviewed fork. **[SECURITY_REVIEW.md](SECURITY_REVIEW.md)** has the full
review: what was checked, how it was verified, and every change from upstream.

## What this software handles

Your Microsoft 365 credentials and the access tokens derived from them. Specifically:

- `~/.config/opencode-copilot/msal-cache.json` — the MSAL token cache, including refresh
  tokens. Written owner-only (`0600`).
- `~/.config/opencode-copilot/browser-profile/` — a persistent browser profile holding
  Entra device/SSO cookies, used by the interactive sign-in window.
- `~/.config/opencode-copilot/debug.log` — written only under `M365_DEBUG`/`M365_TRACE`.
  Every line passes through `redact()` (access tokens, bearer headers, JWTs, token fields).
- `~/.config/opencode-copilot/settings.json` — the page's settings. No credentials.
- `~/.config/opencode-copilot/monitor/` — while a gateway with a page runs, its page link
  (which carries the page's key). Deleted when the gateway stops.

This fork never reads or writes a `secrets.json`. Upstream's automated sign-in kept a
password and TOTP seed there; if an old copy is on disk, `opencode-m365 doctor` warns you
to delete it.

The directory and the browser profile are created (and, if they already exist, tightened
to) owner-only `0700`; every file written in it is `0600`.

## Where it connects

Enforced in code by `src/egress.ts` (TLS, port 443, exact hosts, per purpose):

| Purpose | Hosts | When |
|---|---|---|
| Sign-in / token refresh (MSAL) | `login.microsoftonline.com` | `login`, and silent refresh |
| Chat and image upload | `substrate.office.com` | every model turn |

Nothing else: no analytics, no update checks, no downloads. Upstream's Copilot Studio
agent, and the Power Platform hosts it used, are removed.

Redirects are never followed (a hop would otherwise go unchecked). The `baseUrl` option,
for pointing the plugin at an already-running proxy, is accepted only for a loopback
address: opencode sends every prompt to it.

The sign-in browser window is outside that guard: it shows Microsoft's (or your IdP's)
sign-in pages and loads whatever they reference. The browser's own background services
(for Chrome: Google's account check, push messaging and component updates) are pointed at a
closed local port; `opencode-m365 doctor --browser` lists anything your browser still
tries to contact by itself.

Nothing is loaded from outside this checkout: the bundle's only runtime `require`s are
Node built-ins (ws's optional native add-ons are stubbed out), and `login` loads
Playwright only from this checkout's own `node_modules`.

## The local proxy

It binds to loopback only, and loopback alone is not a boundary — every web page open in
your browser can reach `127.0.0.1` too. So the proxy also:

- requires `Authorization: Bearer <key>` on every request but `/health`. The in-process
  proxy generates a fresh 32-byte random key per launch and hands it only to opencode;
  `opencode-m365 serve` prints its key, or uses `M365_PROXY_KEY`;
- refuses any request carrying a browser `Origin`, refuses every CORS preflight, and
  sends no CORS headers;
- refuses a `Host` that is not a loopback name on its own port (DNS rebinding);
- caps request bodies at 32 MB.

Treat the `serve` key like a password: anything holding it can spend your Copilot quota.
Do not run `opencode-m365 serve` on a shared host.

## The page

A second loopback listener serves the gateway's page. It needs a per-launch key, carried in
the link's `#fragment` (never sent to a server) and then sent in an `Authorization` header.
It refuses other hosts, origins and sites, sends a strict content security policy, and
renders everything as text. It can save a setting, open a sign-in window and send one
fixed test message; it never edits OpenCode's config. Traffic and Checks stay in memory.

## Before sharing a log

Log lines and turn-log entries are redacted, but `M365_TRACE=1` and `M365_TURN_LOG` still
record full prompts and replies, which can quote anything from your workspace. Review a log
before attaching it anywhere.

## Reporting a vulnerability

Open a private security advisory on this repository rather than a public issue. If it also
affects upstream, report it to [chrischall/opencode-copilot-plugin](https://github.com/chrischall/opencode-copilot-plugin/security/advisories/new).

## Scope note

This client speaks to Microsoft's undocumented first-party API using your own credentials
on your own account, signing in as Microsoft's own Office web Copilot client. Whether that is
permitted is a matter for your tenant's acceptable-use policy, not a security property of
this software.
