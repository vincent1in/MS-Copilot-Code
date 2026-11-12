# AGENTS.md

Working notes for agents and humans editing this repo.

## Fork rules (safety-reviewed fork — read first)

This repo is a reviewed fork; [SECURITY_REVIEW.md](SECURITY_REVIEW.md) is the source of
truth for why. Changes must keep these properties, and any change that touches them is a
security review event, not a routine edit:

1. **Egress allowlist.** Every outbound request goes through `assertEgress` (or, for MSAL,
   `createGuardedNetworkClient`) in `src/egress.ts`. Do not add a destination, a scheme, a
   port, or a request path that bypasses it.
2. **No network in tests or CI.** The suite runs with `test/net-guard.setup.ts`; CI preloads
   `scripts/net-guard.cjs` into every Node process. Do not weaken either.
3. **Nothing from npm at run time.** The package stays `private`, `setup` writes a local path,
   dependencies are exact-pinned, `.npmrc` keeps `ignore-scripts=true`. A new runtime
   dependency must be bundled, reviewed, and added to `packaging.test.ts`.
4. **Interactive sign-in only.** Never reintroduce stored passwords, TOTP seeds or headless
   credential entry.
5. **No tenant side effects.** Upstream's Copilot Studio agent is removed; do not bring
   back anything that creates or changes resources in the tenant. `doctor` stays read-only.
6. **Opt-in data sharing.** Bing web search stays opt-in (`webSearch` / `M365_WEB_SEARCH=1`);
   no mailbox-grounded models; Work IQ replies are held by default.
7. **OpenCode's config changes only when the user asks**: the page's Connect button or
   `setup`. Either one adds this folder (and, if asked, the three quiet keys), keeps the rest
   of the file, saves a `.bak` first, refuses invalid JSON and never rewrites an
   `opencode.jsonc`. The page's endpoints keep the monitor's protections (key, `Host`,
   `Origin`, `Sec-Fetch-Site`, JSON only).
8. **The sign-in browser stays quiet**: keep `QUIET_BROWSER_ARGS` in `src/login.ts`, and
   re-measure with `doctor --browser` when Playwright or the browser changes.
   `scripts/sealed-network/run.sh` re-runs the whole outbound and inbound check on Linux.
9. **Tokens never reach logs** — everything written by `log.ts` or the turn log passes `redact()`.
10. **CI** stays read-only, secret-free, with actions pinned to commit SHAs.

## What this is

An opencode plugin that makes Microsoft 365 Copilot usable as opencode's model backend.
It implements M365's undocumented SignalR protocol, exposes it as an OpenAI-compatible
proxy, and constrains opencode enough that M365 will engage with it.

Start with the README — it explains the Disengaged constraint, which is the reason almost
every design decision here is what it is.

## The one rule that shapes the architecture

**Anything that has to change what M365 receives belongs in the proxy, not in an opencode
hook.** Two opencode 1 levers were tried and measured non-functional in 1.18.18, and
opencode 2's replacements (`tool.transform`, `session.hook("context")`) have not been
measured against a live tenant:

| Lever | What happens |
|---|---|
| `config.tools` from the `config` hook | Resolved into the config, visible in `opencode debug config`, and then ignored — the request still offers every tool |
| `experimental.chat.system.transform` | Fires, accepts a replacement `system` array, and the original prompt is sent anyway |
| `agent.<name>.prompt` from the `config` hook | Ignored the same way |

The proxy sees the final OpenAI request. That is where `selectLeanTools` and
`condenseSystemPrompt` run, and where anything similar should go.

If you re-test these on a newer opencode and one starts working, say so in the README —
do not silently move the logic back.

## Layout

| File | Responsibility |
|---|---|
| `src/session.ts` | SignalR over WebSocket: framing, the mandatory Metrics frame, ping, stop, Disengaged |
| `src/auth.ts` | MSAL silent refresh. **Never opens a browser** |
| `src/login.ts` | The browser sign-in. CLI-only, Playwright is an optional dependency |
| `src/egress.ts` | The outbound allowlist, and MSAL's guarded network client |
| `src/fenced.ts` | The fenced tool-call contract, both directions, plus the hardening layers |
| `src/image.ts` | Image input: collect `image_url` parts, upload to M365, build the annotation |
| `src/translate.ts` | OpenAI ⇄ M365: conversation pooling, delta sends, prompt condensing, streaming |
| `src/server.ts` | The HTTP surface. `node:http`, loopback only, per-launch bearer secret, no CORS |
| `src/config.ts` | Provider config and tool policy — the pure decisions |
| `src/plugin.ts` | The entry. One default export, `{ id, setup }` — nothing else |
| `src/plugin-v2.ts` | opencode 2's `setup()`: provider/model transforms and the title hook |
| `src/runtime.ts` | Resolve options, start the proxy (or use an external one), and the page if asked |
| `src/settings.ts` | The saved settings, and which environment variable or plugin option pins each |
| `src/opencode-config.ts` | Reading OpenCode's config for the page; `setup`'s edit, with a backup |
| `src/open-url.ts` | Opening the page in the default browser (the only child process) |
| `src/monitor/` | The page: its loopback server, the turn recorder, Set up's controller, and `ui/` |
| `src/cli.ts` | `opencode-m365 start \| open \| login \| setup \| serve \| monitor \| doctor` |

## Testing

TDD, `npm test` (typecheck, then vitest). The repo is npm — `package-lock.json`, `npm ci`
in CI — and `pnpm test` silently installs a pnpm tree on top of it. No network, no credentials, no live M365 — ever, in the test suite.

`test/stub-copilot.ts` speaks enough of the real protocol to drive a full turn, and
records every frame the client sends so tests can assert on things the real server
punishes silently. The most important of those: **the `Metrics` frame must ride in the
same `ws.send()` as the chat frame**, or the turn produces no output and no error.

Frames the client sends after a turn resolves — a pong, the stop frame on abort — are
still in flight when the awaited call returns. Use `connection.waitForFrame`, not a
direct read of `frames`.

For an end-to-end check through real opencode without touching Microsoft, run the proxy
against the stub and point the plugin at it with the `baseUrl` and `apiKey` options
(`serve` prints the key, or set `M365_PROXY_KEY` for both sides).

## The plugin entry

This is an opencode 2 plugin only; opencode 1 support ended after 0.4.x.
`src/plugin.ts` default-exports `{ id, setup }`, and two rules hold it together, both
pinned in `src/plugin-entry.test.ts` against the built artefact:

- **That module exports `default` and nothing else.** A loader that walks exports and
  finds a second plugin-shaped value starts the proxy twice.
- **No `./server` export subpath in package.json.** That name is opencode's for a
  plugin's server entry; pointing it at the HTTP proxy was issue #26.

`package.json` `overrides` force `glob` ^14 and `minimatch` ^11 (GHSA-g3hv-75wg-m249,
which has no 9.x/10.x fix). Both only reach the dev tree, through `@opencode/plugin`'s
own dependencies, and they move **together**: glob 13 and earlier call minimatch APIs
that 11 removed. Drop both once `@opencode/plugin` resolves minimatch ≥ 11.0.1 on its own.

`@opencode/plugin` is not a runtime dependency. It is a type-only import and must stay
in `tsdown.config.ts`'s `external`: miss it there and the dts bundler inlines
`@opencode/schema` and effect, turning `plugin.d.mts` into 16 MB.

## Things that will bite you

- **Disengaged is not rate limiting.** Empty content, no error. Retrying makes it worse
  and burns the 600-per-conversation quota. `DisengagedError` exists so this is never
  confused with a throttle.
- **An empty reply returning in under a second with `throttle: null` is a dead agent**,
  not throttling. Real throttling reports the quota at its limit.
- **Never delete a declarative agent.** Another host on the tenant may be mid-conversation
  with it, and pulling it away produces exactly the instant-empty-reply symptom above.
- **The agent overrides the tone.** With an agent attached, a Claude or reasoning tone
  silently routes to GPT. Attach it only for tool turns.
- **Prompt shape, not size, trips the filter.** 500k tokens of benign input is fine; a
  shouty ALL-CAPS prompt with fake role turns is not. When editing any prompt in
  `fenced.ts` or `runtime.ts`, lean softer, not harder. There are tests asserting the
  absence of jailbreak shapes — they are there on purpose.
- **Session titles must never reach M365.** The throttle counts conversations started;
  titling every session on the main model is the fastest route into it. opencode 2 has
  no `small_model`, so the plugin marks the title request with `AUX_REQUEST_KIND_HEADER`
  and the proxy answers it locally. The `setSmallModel` option keeps its opencode 1 name
  so existing configs keep working.
- **opencode 2 swallows plugin load failures.** A wrong entry shape, or a catalog record
  that has drifted out of schema, is not an error — it is a plugin that silently never
  loads. That is why `config.test.ts` checks our hand-built provider and model records
  against the real constructors in `@opencode/plugin`.
- **opencode 2 refuses a file path in `plugins`.** It wants a directory, and says so
  only as a `configured plugin path must be a directory` warning in the server log.

## Provenance

The protocol is implemented from the documentation in
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) (MIT) —
`docs/m365-copilot-api.md`, `docs/tool-calling.md`, `docs/prompt-engineering.md`. This is
an independent implementation, not a fork; no code was copied. When M365 behaviour is
unclear, those documents are the reference, and they record measurements we have not
repeated ourselves.
