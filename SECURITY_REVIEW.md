# Security review: opencode-m365-copilot (fork)

| | |
|---|---|
| **Reviewed** | [chrischall/opencode-copilot-plugin](https://github.com/chrischall/opencode-copilot-plugin) at `2c03d2ffee0bf0a269b601e791ff4152b83d8391` (v2.2.1, 2026-11-10), MIT. Tagged `upstream-v2.2.1` in this repo. |
| **Scope** | All of `src/` (19 files, ~5,000 lines of TypeScript, plus tests), build and test config, the five GitHub workflows, `package.json` and the full lockfile (377 entries). |
| **Date / by** | 2026-11-10, performed by Claude (an AI assistant) for this repo's owner, then checked by a second, independent AI pass that had not seen the review being written ([below](#independent-verification)). **Have a person sign off before relying on it.** |
| **Question asked** | Can it pull anything down or send anything anywhere you would not expect? Verified from the code and by running it, **not from comments or docs**. |

## Verdict

**Nothing malicious and nothing hidden.** Upstream has:

- no telemetry, no auto-update, and no code that downloads anything (it never imports `child_process`, so it cannot shell out to `npx`, `curl` or an installer);
- no `eval` and no dynamic import of anything but fixed package names;
- no obfuscation. The one embedded base64 blob decodes to a 115-byte, 48×48 PNG icon.

Every hardcoded destination is a Microsoft host. Run with every outbound connection blocked and recorded, upstream's whole typecheck, build and test cycle (25 Node processes and workers) made **zero** connections off the machine.

What a fork *does* need to change is mostly about what runs **around** the code. Upstream's CI runs another person's mutable workflows. Its `setup` makes opencode install the published npm package rather than your checkout. Several features change your tenant, store credentials or share data by default. The independent pass then found smaller gaps in upstream and in this fork's own first round of changes:

- redirects that skipped the allowlist;
- an unvalidated `baseUrl`;
- modules loaded from parent directories;
- two slow regexes.

All of these are fixed here (see [Findings](#findings)), and the result is enforced by tests rather than by convention.

## How it was checked

1. **Imports and globals.** Built an import map of every source file, then searched for globals that need no import.
   - `agent`, `auth`, `login`, `server` and `session` reach the network through imports (`ws`, MSAL, `node:http`, `node:dns`).
   - `image` (the upload) and `cli` (`doctor`'s loopback self-check) use the global `fetch`.
   - In this fork, `egress` also uses `fetch`, as MSAL's guarded client.
2. **Every I/O call site.** Searched every file for `fetch(`, `WebSocket`, `http`/`https`/`net`/`tls`/`dns`, `child_process`, `eval`, `new Function`, `vm`, dynamic `import(`, `require(`, base64 decoding, `fromCharCode`, `\x` escapes, file writes and `process.env` reads, then read each file that does I/O in full.
3. **Embedded data.** Decoded the embedded data instead of trusting its comment.
4. **Supply chain.**
   - Checked that every lockfile entry resolves to `registry.npmjs.org` with a `sha512` integrity hash.
   - Listed the runtime tree, which is 21 packages.
   - Found which packages carry install scripts in the lockfile, and confirmed the result by scanning every installed `package.json`.
   - Ran `npm audit` on the runtime tree and on the full tree.
5. **Runtime tracing.** Wrote [`scripts/net-guard.cjs`](scripts/net-guard.cjs), a preload that records (and optionally blocks) DNS, socket connects and `fetch` in every Node process a command starts.
   - **What it hooks:** `net.Socket.prototype.connect`, which every client ends up in (tls, http agents, undici/fetch, `ws`); `dns.lookup`; and, since the independent pass, the c-ares resolver functions.
   - **Logging:** it never logs query strings.
   - **Self-test:** it catches `fetch`, `https.request`, both DNS paths and `ws`, and a token in a WebSocket URL never reaches its log.
   - **Limit:** it sees only JavaScript running in Node. In CI, the build and tests therefore also run in a network namespace with no route off the machine. That stops native code too, such as TypeScript 7's `tsc` binary and the bundler's core.
6. **Production paths.** Drove each production path with fake credentials while blocking, to record where each one tries to connect.
7. **Repeat on the fork.** Ran the same checks on this fork after the changes.

### Results

| Check | Upstream | This fork |
|---|---|---|
| Lockfile sources | 377/377 `registry.npmjs.org`, all with integrity | 375/375 (otpauth and @noble/hashes removed) |
| Install scripts (preinstall/install/postinstall) | only `fsevents` (macOS-only, optional, dev) | same |
| Runtime packages | 21 | 19 |
| `npm audit` (runtime / all) | 0 / 0 vulnerabilities | 0 / 0 |
| Typecheck + build + tests, all non-loopback network blocked | 25 contexts, 483 tests, **0 attempts** | 27 contexts, 526 tests, **0 attempts**, plus the guard's 5 deliberate self-test probes to `*.invalid`. Also run inside a network namespace with no route out, where it passes. |
| Same run under `strace -f`, including native binaries (independent pass) | 0 non-loopback connect/sendto/sendmsg | 0 |
| Runtime `require` from disk in the built bundle | `bufferutil` and `utf-8-validate`, resolved through every parent `node_modules` | Node built-ins only |
| Code generated at run time | zod JIT-compiles its object parsers with `new Function` (built from our static schemas) | none: our one runtime parse passes `{ jitless: true }`, and zod's global config is untouched |
| `npm audit signatures` | could not run in the review sandbox: its egress proxy returned 403 on a registry endpoint. **Run it locally.** | same |

### Where each production path connects (measured)

| Path | Upstream | This fork |
|---|---|---|
| Chat turn | `wss://substrate.office.com/m365Copilot/Chathub/…` | same |
| Image upload | `POST https://substrate.office.com/m365Copilot/UploadFile` | same |
| Token refresh (MSAL) | `POST https://login.microsoftonline.com/common/oauth2/v2.0/token` | same, through the allowlisted network client |
| First tool turn through the proxy | `GET https://api.bap.microsoft.com/…/environments/~default`, then Copilot Studio, **then** chat | chat only (Studio agent is opt-in) |
| Studio agent, when enabled | `api.bap.microsoft.com`, then `default<id>.<xx>.environment.api.powerplatform.com` | same, with the hostname validated |
| Endpoint pointed at `evil.example` | would connect | refused by `src/egress.ts`, **no connection attempted** |
| An allowlisted host answers `307` to another host | the body (a refresh token, an image) is re-sent there | the request fails; the redirect target receives nothing |
| `baseUrl` option set to a remote host | opencode sends every prompt and the proxy key there | ignored; the in-process proxy is used instead |

## Findings

Line numbers refer to upstream `2c03d2f`.

| # | Severity | Finding | Where (upstream) | Fixed in |
|---|---|---|---|---|
| F1 | **High** (fork) | CI runs third-party workflows from a mutable branch with write access and secrets. All five workflows call `chrischall/workflows/…@main`. `auto-merge.yml` runs on `pull_request_target` with `contents: write`; `claude.yml` has `contents: write` and `id-token: write`. In a fork, whoever controls that branch controls your CI. | `.github/workflows/auto-merge.yml:7,11,20`; `claude.yml:20,23,28`; `pr-auto-review.yml:25,64`; `release-please.yml:43,52` | `3bd340a`: removed; new CI is read-only, secret-free, SHA-pinned, network-blocked |
| F2 | **High** (fork) | `setup` registers the plugin by its **npm name**, so opencode installs the *published upstream package* on its next start. You would run code that was never reviewed. | `src/cli.ts:92` | `a038b6f`: always the local checkout path, and an upstream entry is replaced. `3bd340a`: `private: true` and renamed |
| F3 | Medium | **Changes your tenant by default.** The first tool turn (and every opencode turn carries tools) creates and publishes a Copilot Studio bot `m365-tool-agent-<hash>` in the default Power Platform environment. It is never deleted, by design. `doctor`, a health check, does the same. | `src/runtime.ts:85`; `src/agent.ts:16,142,278,298`; `src/cli.ts:160,213` | `dedb212`: opt-in (`studioAgent` / `M365_STUDIO_AGENT=1`); `doctor` is read-only |
| F4 | Low | **A bearer token can be sent to an unvalidated host.** The Power Platform hostname is built from the BAP environment name (`Default-<guid>`, not validated) and from `M365_POWERPLATFORM_HOST` (any value), then receives a Power Platform token. A crafted name with `/`, `#` or `?` (e.g. `Default-evil.example/xx`) would change the URL's host, but upstream's DNS probe of the full string refuses such names. So in practice only the env-var override reaches an arbitrary host, and that needs control of your environment. (The first version of this review over-rated this as Medium, with a wrong example.) | `src/agent.ts:90,102,185` | `a55009e`: the id must be 32 hex digits; the override must be `*.environment.api.powerplatform.com`; the allowlist applies on top |
| F5 | Medium | **Stored password and TOTP seed.** Automated login reads `{email, password, mfaSecret}` from `secrets.json` and types them into the sign-in page. Whoever reads the file passes MFA as you. | `src/login.ts:29,106,224` | `13bede4`: removed; sign-in is interactive only; `doctor` warns about a leftover file |
| F6 | Medium (privacy) | **Bing web search on every agent-less coding turn**, so Copilot can turn parts of your code into Bing queries. In this fork agent-less is the normal path. | `src/session.ts:500` | `211d0fb`: opt-in (`webSearch` / `M365_WEB_SEARCH=1`) |
| F7 | Low (compliance) | **Mailbox-grounded `work` models** switch to the Outlook side-pane scenario, search mail, Teams and files, and send `feature.EnableStarterLicenseCheckBypass`. | `src/session.ts:61-63`; `src/models.ts:69` | `0aca714`: removed |
| F8 | Low | **No egress enforcement.** Destinations were only as good as each call site, and MSAL used its own HTTP client. | — | `a55009e`: `src/egress.ts` allowlist per purpose (TLS, port 443, exact hosts); MSAL gets a guarded `networkClient`. Redirects completed in F13 |
| F9 | Low | **Tokens can reach the debug log.** Upstream's own note says `M365_TRACE` logs carry the access token, which travels in the chat URL. No current path was found that logs it. | `src/private-fs.ts:6`; `src/session.ts:312` | `1378e78`: every log line and turn-log entry is redacted |
| F10 | Info | **Version ranges and install scripts.** `package.json` used `^` ranges, and installs could run dependency lifecycle scripts. | `package.json` | `3bd340a`: exact pins; `.npmrc` `ignore-scripts=true`; CI uses `npm ci --ignore-scripts` |
| F11 | Info | **Runtime code generation.** zod v4 JIT-compiles parsers with `new Function`. Not exploitable here: the generated code comes from our static schemas, not from input. | bundled `zod` | `6388e5e`: `{ jitless: true }` on our one runtime parse. An earlier global `z.config()` (`30c31bf`) was reverted: zod keeps its config on `globalThis`, so it also changed opencode's own zod |
| F12 | Info (not changed) | **Signs in as Microsoft's own client.** It uses the Office web Copilot client id `c0ab8ce9-…`, a browser-shaped `Origin` and User-Agent, and the Copilot Studio portal's user agent. This is inherent to the approach and is a policy question, not a code defect. | `src/auth.ts:25`; `src/session.ts:36-40`; `src/agent.ts:48` | Documented in [Residual risks](#residual-risks) |
| F13 | Medium | **Redirects skipped the allowlist.** `fetch` follows redirects and only the first URL was checked, so a `307` from an allowlisted host would re-send the body (a refresh token from MSAL's client, an image) to a host the allowlist never saw. undici drops `Authorization` across origins, but not the body. Practically this needs a Microsoft endpoint to redirect, or TLS interception. **A gap in this fork's first allowlist, found by the independent pass.** | `src/egress.ts`, `src/image.ts`, `src/agent.ts` (fork) | `a4176d1`: `redirect: "error"` everywhere; tests use a real `307` and the target receives nothing |
| F14 | Medium | **`baseUrl` was not validated.** The plugin option for an external proxy became opencode's provider `baseURL` as given, so a config pointing it elsewhere sends every prompt (your code) and the proxy key there. `setup` could also carry it over from an upstream entry. | `src/config.ts:167`, `src/runtime.ts:68-77` | `ef4d61c`: loopback http(s) only; anything else falls back to the in-process proxy, with a logged warning |
| F15 | Low | **Modules loaded from parent directories.** Bundled, ws's optional `require('bufferutil')` and `require('utf-8-validate')` became runtime requires resolving through every parent `node_modules`. A package planted anywhere up the tree ran inside opencode's process (reproduced). `login`'s `import("playwright")` walked parents the same way. | bundled `ws`; `src/login.ts:265` | `f8abd65`: both add-ons aliased to a stub that throws (ws treats it as missing). Playwright resolves from the checkout only and a path outside it is refused. A planted parent copy is now not executed |
| F16 | Low (DoS) | **Quadratic regexes on model output**, run synchronously on opencode's event loop. Upstream's `stripInventedJson` (`^\s*` under the m flag) took ~4 s on a reply of 40k blank lines. This fork's first `redact()` took 31 s on 200 KB (only when logging is on). | `src/fenced.ts:440,451`; `src/log.ts` (fork) | `a6e9092`, `54e86b3`: linear-time patterns (9 ms and 5 ms), with timing tests. Redaction also covers form bodies, the sign-in `code`, escaped and camelCase JSON fields, and JWE |
| F17 | Info | **The network guard had blind spots.** A `127.` prefix check let `127.attacker.example` through. `dns.resolve*` and `dns.Resolver` weren't hooked. Native binaries are invisible to any Node hook. A missing log passed CI silently. | `scripts/net-guard.cjs`, `ci.yml` (fork) | `4b37c6c`: strict loopback check, resolver hooks, a network namespace with no route out for the CI build and tests, and a missing log fails |
| F18 | Info (not changed) | **Env vars can move where files are written**: `M365_CONFIG_DIR`, `M365_CACHE_FILE`, `M365_AGENT_FILE`, `M365_TURN_LOG`, `M365_BROWSER_PROFILE`. `ensurePrivateDir` sets an existing directory to `0700` unless it is `$HOME` or above, so `M365_CONFIG_DIR=/tmp` would do that to `/tmp`. A relative `M365_TURN_LOG` writes into the project. These are user-set, as in upstream. | `src/paths.ts`, `src/private-fs.ts` | Documented; don't point these at shared directories |

### Behavior change: default model

`d36f6db` changes the default model, which isn't a security fix. The Studio agent is opt-in here, so tool turns normally run agent-less. The default is now `gpt-6.1-sol` on the `relay` framing (with `gpt-6-sol` added), because the reference project measured these as the reliable agent-less choice on accounts without a paid Copilot seat. See the comment on `DEFAULT_MODEL` in `src/models.ts`. This has not yet been re-measured through this fork on a live tenant.

### Checked and found fine (unchanged)

- **Local proxy.**
  - Binds loopback only and refuses anything else (`src/server.ts:147`).
  - Requires a per-launch 32-byte random bearer key, compared in constant time.
  - Refuses a non-loopback `Host`, which defeats DNS rebinding.
  - Refuses any request carrying a browser `Origin`, refuses CORS preflights and sends no CORS headers (`:256`).
  - Caps request bodies at 32 MB.
- **Files.**
  - The config dir is `0700` and every file in it `0600`, tightened if loose.
  - It never chmods `$HOME` or above, compared by real path, so a symlink cannot trick it.
  - The MSAL cache is owner-only.
- **Plugin auth.** The plugin is silent-refresh-only and never opens a browser.
- **Images.** Upload accepts only `data:` URLs and never fetches a remote image, so there is no server-side request forgery (SSRF) path.
- **Model output.** It only ever becomes OpenAI `tool_calls` or text returned to opencode, plus at most one automatic follow-up turn to M365 when a reply looks like a give-up. Nothing in the proxy executes it. opencode runs the tool calls (see [Residual risks](#residual-risks)).
- **Playwright.** It is an optional peer dependency. Nothing installs it or a browser automatically. When it is missing, the CLI stops and says so.
- **Dev-only dependencies.** `@opencode/plugin` pulls in OpenTelemetry and Google auth libraries. It is a type-only import and none of it reaches the bundle (checked: zero occurrences in `dist/`).
- **Bundle URLs.** Besides the allowlisted hosts, the bundle holds documentation links in bundled-library comments. It also holds MSAL's sovereign-cloud authorities and IMDS address, which can't be contacted: every MSAL request goes through the guarded network client.

## Independent verification

A second AI agent, which had not seen the review being written, checked twelve claims against the code at `6dc507f`. It was told to trust nothing but the code.

**Passed:**
- Every direct HTTP or WebSocket call site is guarded, and both MSAL constructions get the guarded client.
- 90 adversarial URLs couldn't get past the allowlist: look-alike hosts, userinfo, `\`, `#@`, encoded dots, IPv6-mapped addresses, homographs, other ports and schemes.
- Studio provisioning is opt-in, and nothing reads a password or `secrets.json`.
- Bing is opt-in, the `work` models are gone from source and bundle, and `setup` replaces npm entries.
- CI permissions are as stated, the cited upstream line numbers are accurate, and each fix commit does what its row says.
- Under `strace -f`, the guarded runs of both upstream and the fork made zero non-loopback syscalls.

**Found:** F13–F17 above, F18 as a residual risk, two over-stated claims in the first version of this review (F4, and "only five files reach the network"), and the process-wide zod setting (F11). Each fix was reproduced before it was made, and each new test fails without its fix.

## Residual risks

These cannot be fixed in code. Decide on them deliberately.

1. **Terms and policy.** This speaks to an undocumented Microsoft API, signing in as Microsoft's own Copilot client. That may conflict with Microsoft's terms or your tenant's acceptable-use policy. Admins can see the sign-ins and usage, and Microsoft can throttle or block it at any time.
2. **Your code goes to Microsoft 365 Copilot.** That is the point of the tool, and it is governed by your tenant's Copilot data policies. The connection still sends the captured `feature.EnableWebSearch` and `feature.EnableCodeInterpreter` variants (upstream notes that removing variants is untested). Without the Bing plugin, a turn is not offered web search.
3. **Model output becomes actions.** Replies are parsed into tool calls that opencode runs on your machine (shell commands, file edits). Content in your repo, or a model mistake, can steer that. Keep opencode's permission prompts on for `bash` and edits.
4. **Outside the guard.**
   - The sign-in browser window loads Microsoft's or your IdP's pages and their assets.
   - `npx playwright install chromium`, if you choose it, downloads Playwright's Chromium.
   - opencode itself and any other plugins share the process.
5. **Not yet verified live.** The fork's defaults (Sol model, Bing off, Studio off) have not been run against a live tenant here. Run `node dist/cli.mjs doctor --live` and a small task first.
6. **User-set paths.** The `M365_*` path variables (F18) decide where tokens, logs and the browser profile are written. Leave them unset, or point them at private directories.
7. **MSAL network client.** `createGuardedNetworkClient` mirrors MSAL's fetch-based client, which msal-node does not export. A future msal-node could change that interface; the tests cover its shape. Errors come through as raw errors rather than MSAL's own types; for this app that is equivalent, since every failure means "sign in again". Egress denials are logged, because MSAL re-wraps them.

## Addendum: gateway monitor and Work IQ (branch `gateway-monitor`)

2026-11-12, by Claude, on top of `security-hardening`. This adds two things: a page that shows what each turn sends and receives, and a check on every turn for Copilot drawing on your work data. Both change what the code can do, so they are reviewed here on the same terms as the original findings.

| # | Topic | Decision and why | Enforced by |
|---|---|---|---|
| M1 | **A new listener serving sensitive data.** The monitor shows every prompt, file the agent read and reply. | It is **off by default**. When on, it runs as its own loopback listener on its own port and origin, so the proxy's "refuse every browser" rule is untouched. Protections:<ul><li>a loopback-only bind and `Host` check (DNS rebinding);</li><li>a per-launch 32-byte key, required in an `Authorization` header and compared in constant time;</li><li>`Origin` must be its own, `Sec-Fetch-Site` must be same-origin, preflights are refused and no CORS headers are sent;</li><li>a CSP of `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`, plus `nosniff`, `no-store` and `no-referrer`;</li><li>a static page with no data in it, rendered with `textContent` only;</li><li>at most 4 streams, and a slow reader is dropped past 64 MB of backlog.</li></ul> | `src/monitor/server.test.ts`, `src/monitor/built.test.ts` |
| M2 | **How the key reaches the page.** | It travels in the link's `#fragment`, which browsers never send. The page moves it to that tab's session storage and removes it from the address bar. For the plugin, `opencode-m365 monitor` reads the link from an owner-only file (`0600` in a `0700` dir), which is deleted on exit; stale ones are swept. The link is never written to opencode's log. Any process running as you can read that file — the same boundary as the MSAL cache, which holds far more. | `src/monitor/links.test.ts` |
| M3 | **What the monitor keeps.** | It is memory only: capped at 5,000 events and about 24M characters, cleared by Clear or when the gateway stops, and never written to disk. Conversation content is kept **verbatim**, on purpose, because the user asked to see exactly what was sent. The gateway's own credentials never enter it: the access token rides in the WebSocket URL, which is recorded as host, path and parameters minus `access_token`. Plumbing fields (summaries, details, parameters, the request envelope, error messages) also go through the log redactor. | `src/monitor/gateway.test.ts` ("never records the access token"), `src/monitor/monitor.test.ts` |
| M4 | **Key-like text in prompts.** | Flagged, never altered. It was really sent, and the page must not understate that. The scanner is a linear-time heuristic with timing tests. It knows about ten shapes (PEM keys, JWTs, AWS, GitHub, Slack and Azure keys, bearer tokens, database URLs with passwords, `.env` secrets) and will miss others. | `src/monitor/secrets.test.ts` |
| M5 | **Work IQ.** Copilot may draw on email, files, chats and meetings, and whether it does so for this gateway's requests is unverified. | Every turn is checked, with the monitor on or off. Evidence comes from structured protocol traffic only: search messages placed by the search call's name, and source attributions placed by host. Under the default `hold` policy:<ul><li>a reply drawn from work data never reaches opencode — it gets `m365_work_data_held`;</li><li>the conversation is dropped, so Copilot's work-grounded context goes with it;</li><li>tool-less replies are buffered rather than streamed, because the evidence can arrive last.</li></ul>A search the gateway cannot place is flagged, never held. `flag` and `allow` relax this. | `src/workiq.test.ts`, `src/monitor/gateway.test.ts` |
| M6 | **Egress decisions are now announced.** | `onEgress` listeners hear host and purpose only, never the URL. A listener that throws is ignored, and listeners cannot change a decision. Each decision is tied to its turn through `AsyncLocalStorage`. The listener is removed when the server closes. | `src/egress.test.ts`, `src/monitor/gateway.test.ts` |

**Not new:** the page's script and styles are plain files in this repo (`src/monitor/ui/`), served from `dist/ui/` and checked into review like any other source. No package, font, CDN or framework was added; `package.json` is unchanged.

**Results.** 634 tests pass (up from 526). The CI path — typecheck, build and the whole suite inside a network namespace with the guard blocking — guarded 37 Node processes and recorded 0 non-loopback attempts, apart from the guard's own 5 self-test probes to `.invalid` hosts. The page was checked in headless Chrome against a scripted session: no console errors, the key removed from the address bar, reload working, and a tab without the key refused.

**Residual:**

1. Detection depends on undocumented message shapes. Grounding that leaves no structured trace cannot be seen.
2. Whether the Work IQ button's off state can be requested explicitly is unknown. Capturing what the real Copilot web client sends with the button off, on a licensed account, would settle it.
3. Neither feature has run against a live tenant yet.

## Re-verify it yourself

```sh
git clone https://github.com/vincent1in/opencode-m365-copilot.git && cd opencode-m365-copilot
npm ci --ignore-scripts
npm audit --omit=dev && npm audit signatures

# Every Node process the build and tests start, with outbound network blocked and logged:
NODE_OPTIONS="--require ./scripts/net-guard.cjs" NET_GUARD_BLOCK=1 NET_GUARD_LOG=/tmp/net.jsonl \
  sh -c 'npm run typecheck && npm run build && npx --no-install vitest run'
grep '"local":false' /tmp/net.jsonl     # expect only the *.invalid self-test probes

# Linux: the same with the kernel refusing everything but loopback (native binaries too):
sudo unshare --net -- sh -c 'ip link set lo up && exec sudo -u "$SUDO_USER" env PATH="'"$PATH"'" npm test'

# What the bundle still loads at run time (expect Node built-ins only):
grep -ho '__require("[^"]*")' dist/*.mjs | sort -u

# Every network/process/dynamic-code call site in shipped source:
grep -rnE "fetch\(|new WebSocket|child_process|eval\(|new Function|import\(" src --include=*.ts | grep -v '\.test\.ts'
```

## Taking upstream changes later

Upstream history is kept, and the reviewed base is tagged `upstream-v2.2.1`:

```sh
git remote add upstream https://github.com/chrischall/opencode-copilot-plugin.git
git fetch upstream
git diff upstream-v2.2.1 upstream/main -- src package.json package-lock.json .github tsdown.config.ts
```

Review that diff against the [fork rules](AGENTS.md#fork-rules-safety-reviewed-fork--read-first) before merging, and re-run the checks above.
