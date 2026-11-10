# Security review: opencode-m365-copilot (fork)

| | |
|---|---|
| **Reviewed** | [chrischall/opencode-copilot-plugin](https://github.com/chrischall/opencode-copilot-plugin) at `2c03d2ffee0bf0a269b601e791ff4152b83d8391` (v2.2.1, 2026-11-10), MIT. Tagged `upstream-v2.2.1` in this repo. |
| **Scope** | All of `src/` (19 files, ~5,000 lines of TypeScript, plus tests), build and test config, the five GitHub workflows, `package.json` and the full lockfile (377 entries). |
| **Date / by** | 2026-11-10, performed by Claude (an AI assistant) for this repo's owner. **Have a person sign off before relying on it.** |
| **Question asked** | Can it pull anything down or send anything anywhere you would not expect? Verified from the code and by running it, **not from comments or docs**. |

## Verdict

**Nothing malicious and nothing hidden.** Upstream has:

- no telemetry, no auto-update, and no code that downloads anything (it never imports `child_process`, so it cannot shell out to `npx`, `curl` or an installer);
- no `eval` and no dynamic import of anything but fixed package names;
- no obfuscation. The one embedded base64 blob decodes to a 115-byte, 48×48 PNG icon.

Every hardcoded destination is a Microsoft host. Run with every outbound connection blocked and recorded, upstream's whole typecheck, build and test cycle (25 Node processes and workers) made **zero** connections off the machine.

What a fork *does* need to change is mostly about what runs **around** the code. Upstream's CI runs another person's mutable workflows. Its `setup` makes opencode install the published npm package rather than your checkout. Several features change your tenant, store credentials or share data by default. All of these are fixed here (see [Findings](#findings)), and the result is enforced by tests rather than by convention.

## How it was checked

1. **Imports.** Built an import map of every source file. Only `agent`, `auth`, `login`, `server` and `session` can reach the network (`fetch`, `ws`, MSAL, `node:http`, `node:dns`).
2. **Every I/O call site.** Searched every file for `fetch(`, `WebSocket`, `http`/`https`/`net`/`tls`/`dns`, `child_process`, `eval`, `new Function`, `vm`, dynamic `import(`, `require(`, base64 decoding, `fromCharCode`, `\x` escapes, file writes and `process.env` reads, then read each file that does I/O in full.
3. **Embedded data.** Decoded the embedded data instead of trusting its comment.
4. **Supply chain.**
   - Checked that every lockfile entry resolves to `registry.npmjs.org` with a `sha512` integrity hash.
   - Listed the runtime tree, which is 21 packages.
   - Found which packages carry install scripts in the lockfile, and confirmed the result by scanning every installed `package.json`.
   - Ran `npm audit` on the runtime tree and on the full tree.
5. **Runtime tracing.** Wrote [`scripts/net-guard.cjs`](scripts/net-guard.cjs), a preload that records (and optionally blocks) every DNS lookup, socket connect and `fetch` in every Node process a command starts. It hooks `net.Socket.prototype.connect`, which every client ends up in (tls, http agents, undici/fetch, `ws`), and it never logs query strings. A self-test showed it catches `fetch`, `https.request`, `dns.promises.lookup` and `ws`, and that a token in a WebSocket URL never reaches its log.
6. **Production paths.** Drove each production path with fake credentials while blocking, to record where each one tries to connect.
7. **Repeat on the fork.** Ran the same checks on this fork after the changes.

### Results

| Check | Upstream | This fork |
|---|---|---|
| Lockfile sources | 377/377 `registry.npmjs.org`, all with integrity | 375/375 (otpauth and @noble/hashes removed) |
| Install scripts (preinstall/install/postinstall) | only `fsevents` (macOS-only, optional, dev) | same |
| Runtime packages | 21 | 19 |
| `npm audit` (runtime / all) | 0 / 0 vulnerabilities | 0 / 0 |
| Typecheck + build + tests, all non-loopback network blocked | 25 contexts, 483 tests, **0 attempts** | 27 contexts, 507 tests, **0 attempts** (plus the guard's 2 deliberate self-test probes to `*.invalid`) |
| Generated code in the built bundle | zod's `new Function` JIT | none (`jitless`) |
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

## Findings

Line numbers refer to upstream `2c03d2f`.

| # | Severity | Finding | Where (upstream) | Fixed in |
|---|---|---|---|---|
| F1 | **High** (fork) | CI runs third-party workflows from a mutable branch with write access and secrets. All five workflows call `chrischall/workflows/…@main`. `auto-merge.yml` runs on `pull_request_target` with `contents: write`; `claude.yml` has `contents: write` and `id-token: write`. In a fork, whoever controls that branch controls your CI. | `.github/workflows/auto-merge.yml:7,11,20`; `claude.yml:20,23,28`; `pr-auto-review.yml:25,64`; `release-please.yml:43,52` | `3bd340a`: removed; new CI is read-only, secret-free, SHA-pinned, network-blocked |
| F2 | **High** (fork) | `setup` registers the plugin by its **npm name**, so opencode installs the *published upstream package* on its next start. You would run code that was never reviewed. | `src/cli.ts:92` | `a038b6f`: always the local checkout path, and an upstream entry is replaced. `3bd340a`: `private: true` and renamed |
| F3 | Medium | **Changes your tenant by default.** The first tool turn (and every opencode turn carries tools) creates and publishes a Copilot Studio bot `m365-tool-agent-<hash>` in the default Power Platform environment. It is never deleted, by design. `doctor`, a health check, does the same. | `src/runtime.ts:85`; `src/agent.ts:16,142,278,298`; `src/cli.ts:160,213` | `dedb212`: opt-in (`studioAgent` / `M365_STUDIO_AGENT=1`); `doctor` is read-only |
| F4 | Medium | **A bearer token can be sent to an unvalidated host.** The Power Platform hostname is spliced from the BAP environment name (`Default-<guid>`, not validated) and from `M365_POWERPLATFORM_HOST` (any value), then receives a Power Platform token. A name like `Default-evil.example#` redirects the request. | `src/agent.ts:90,102,185` | `a55009e`: the id must be 32 hex digits; the override must be `*.environment.api.powerplatform.com`; the allowlist applies on top |
| F5 | Medium | **Stored password and TOTP seed.** Automated login reads `{email, password, mfaSecret}` from `secrets.json` and types them into the sign-in page. Whoever reads the file passes MFA as you. | `src/login.ts:29,106,224` | `13bede4`: removed; sign-in is interactive only; `doctor` warns about a leftover file |
| F6 | Medium (privacy) | **Bing web search on every agent-less coding turn**, so Copilot can turn parts of your code into Bing queries. In this fork agent-less is the normal path. | `src/session.ts:500` | `211d0fb`: opt-in (`webSearch` / `M365_WEB_SEARCH=1`) |
| F7 | Low (compliance) | **Mailbox-grounded `work` models** switch to the Outlook side-pane scenario, search mail, Teams and files, and send `feature.EnableStarterLicenseCheckBypass`. | `src/session.ts:61-63`; `src/models.ts:69` | `0aca714`: removed |
| F8 | Low | **No egress enforcement.** Destinations were only as good as each call site, and MSAL used its own HTTP client. | — | `a55009e`: `src/egress.ts` allowlist per purpose (TLS, port 443, exact hosts); MSAL gets a guarded `networkClient` |
| F9 | Low | **Tokens can reach the debug log.** Upstream's own note says `M365_TRACE` logs carry the access token, which travels in the chat URL. No current path was found that logs it. | `src/private-fs.ts:6`; `src/session.ts:312` | `1378e78`: every log line and turn-log entry is redacted |
| F10 | Info | **Version ranges and install scripts.** `package.json` used `^` ranges, and installs could run dependency lifecycle scripts. | `package.json` | `3bd340a`: exact pins; `.npmrc` `ignore-scripts=true`; CI uses `npm ci --ignore-scripts` |
| F11 | Info | **Runtime code generation.** zod v4 JIT-compiles parsers with `new Function`. Not exploitable here (static schemas), but unnecessary. | bundled `zod` | `30c31bf`: `z.config({ jitless: true })` |
| F12 | Info (not changed) | **Signs in as Microsoft's own client.** It uses the Office web Copilot client id `c0ab8ce9-…`, a browser-shaped `Origin` and User-Agent, and the Copilot Studio portal's user agent. This is inherent to the approach and is a policy question, not a code defect. | `src/auth.ts:25`; `src/session.ts:36-40`; `src/agent.ts:48` | Documented in [Residual risks](#residual-risks) |

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
- **Playwright.** It is an optional peer dependency. Nothing installs it or a browser automatically. When it is missing, the CLI stops and says so.
- **Dev-only dependencies.** `@opencode/plugin` pulls in OpenTelemetry and Google auth libraries. It is a type-only import and none of it reaches the bundle (checked: zero occurrences in `dist/`).
- **Bundle URLs.** Besides the allowlisted hosts, the bundle holds documentation links in bundled-library comments. It also holds MSAL's sovereign-cloud authorities and IMDS address, which can't be contacted: every MSAL request goes through the guarded network client.

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
6. **MSAL network client.** `createGuardedNetworkClient` mirrors MSAL's fetch-based client, which msal-node does not export. A future msal-node could change that interface; the tests cover its shape.

## Re-verify it yourself

```sh
git clone https://github.com/vincent1in/opencode-m365-copilot.git && cd opencode-m365-copilot
npm ci --ignore-scripts
npm audit --omit=dev && npm audit signatures

# Every Node process the build and tests start, with outbound network blocked and logged:
NODE_OPTIONS="--require ./scripts/net-guard.cjs" NET_GUARD_BLOCK=1 NET_GUARD_LOG=/tmp/net.jsonl \
  sh -c 'npm run typecheck && npm run build && npx --no-install vitest run'
grep '"local":false' /tmp/net.jsonl     # expect only the two *.invalid self-test probes

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
