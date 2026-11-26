# opencode-m365-copilot (safety-reviewed fork)

Use your work account's **Microsoft 365 Copilot Chat** as the AI model in
[OpenCode](https://opencode.ai). This is Microsoft Copilot, not GitHub Copilot. A personal
Microsoft account's Copilot won't work: it is a different service. You don't need Copilot
Studio.

> **This is a reviewed fork** of [chrischall/opencode-copilot-plugin](https://github.com/chrischall/opencode-copilot-plugin)
> (MIT), taken at upstream `v2.2.1` (`2c03d2f`) and brought up to upstream `v2.4.0` in this fork's
> 2.5.0. See **[SECURITY_REVIEW.md](SECURITY_REVIEW.md)** for what was checked, how, and every
> change. In short, compared with upstream:
>
> - **Two addresses and nothing else.** It connects to `login.microsoftonline.com` to sign in and
>   `substrate.office.com` for Copilot, enforced in code. CI fails on any other connection attempt.
> - **No analytics, update checks or downloads.** The sign-in library's reports about itself are
>   stripped, and the sign-in window's own background services are switched off.
> - **Nothing is created in your tenant.** Upstream's Copilot Studio agent is removed.
> - **Interactive sign-in only**: no stored password or TOTP seed.
> - **Your work data stays out.** Bing web search and MCP tool search are off, the
>   mailbox-grounded models are removed, and a reply Copilot drew from your email, files or
>   chats is held back by default.
> - **Nothing that costs extra.** Every model is one a Copilot Chat licence includes; upstream's
>   premium, paid-scenario and credit-billed models are left out.
> - **A page on your computer** walks you through setup and shows exactly what each turn sends.
> - **Nothing is installed from npm.** OpenCode loads the gateway from its folder, never from the registry.
>   One command installs or updates that folder from this repository's releases, checking every file.

## Quick start

You need:

- the OpenCode you already have (version 2), installed from npm;
- Node.js 22 or later;
- Microsoft Edge or Google Chrome, for the sign-in window;
- a work or school account with Microsoft 365 Copilot Chat.

1. **Install** with one command in a terminal.

   macOS or Linux:

   ```sh
   curl -fsSL https://github.com/vincent1in/MS-Copilot-Code/releases/latest/download/install.sh | sh
   ```

   Windows, in PowerShell:

   ```powershell
   irm https://github.com/vincent1in/MS-Copilot-Code/releases/latest/download/install.ps1 | iex
   ```

   It downloads the latest release from this repository, checks it, puts the gateway in
   `~/.local/share/opencode-m365-copilot` (Windows: `%LOCALAPPDATA%\opencode-m365-copilot`),
   and opens the gateway's page. Run the same command again to update. Your settings and
   sign-in are kept, and OpenCode keeps loading the same folder. See
   [Installing and updating](#installing-and-updating) for what the command does, how to read
   it first, and how to install without it.
2. **Follow Set up** on the page:
   1. *Sign in to Microsoft 365.* A browser window opens on Microsoft's sign-in page.
   2. *Send a test message.* You see the exact text that went to Copilot, and its reply.
   3. *Connect OpenCode.* Press **Connect OpenCode**. It adds the gateway's folder to
      `plugins` in OpenCode's config file and changes nothing else in it, saving the file as
      it was to `opencode.json.bak` first. Leave the box ticked to also turn off OpenCode's
      own update checks, session sharing and web search. To do it by hand instead, open
      *Or add it yourself*.
3. **Start OpenCode** in your project with `opencode`. The gateway's models are listed as
   `m365/…`, and `m365/gpt-6.1-sol` is used when you don't pick one.

Once you're set up you can close the page: OpenCode runs its own copy of the gateway. To
open the page again, run `node ~/.local/share/opencode-m365-copilot/dist/cli.mjs start`
(Windows: `node "$env:LOCALAPPDATA\opencode-m365-copilot\dist\cli.mjs" start`). To watch
OpenCode's turns as well, choose what happens *When OpenCode starts* under Settings.

Rather use a terminal for setup too? `node dist/cli.mjs login` signs in, and
`node dist/cli.mjs setup --quiet` adds the folder to OpenCode's config for you, keeping a
backup of the old file. Run them from the gateway's folder.

## Installing and updating

**What the install command does.** It is a short script (`install.sh` for macOS and Linux,
`install.ps1` for Windows), the same file as in this repository:

1. It downloads two files from this repository's latest release on GitHub,
   `opencode-m365-copilot.zip` and `opencode-m365-copilot.zip.sha256`. GitHub serves the
   download from its file host, `release-assets.githubusercontent.com`.
2. It checks the zip's SHA-256 against the published one, then every file in the zip against
   the `SHA256SUMS` list inside it. On any mismatch it stops and installs nothing.
3. It puts the gateway's folder in place, replacing an older copy there. It refuses to
   replace a folder that isn't a copy of the gateway.
4. It starts the gateway's page.

It downloads nothing else, runs no installer, needs no npm, and doesn't touch OpenCode's
config: only the page's Connect OpenCode button does that, when you press it. Your settings
and sign-in live in `~/.config/opencode-copilot`, outside the gateway's folder, so an update
keeps them. If OpenCode is running when you update, restart it to load the new version. On
Windows, close the gateway's page and OpenCode first: Windows won't replace a folder that
a running program is using, and the script says so if that happens.

**To read the script before it runs**, download `install.sh` or `install.ps1` from the
[latest release](https://github.com/vincent1in/MS-Copilot-Code/releases/latest), read it,
then run `sh install.sh` or `powershell -ExecutionPolicy Bypass -File install.ps1`.
`sh install.sh --no-start` (Windows: `-NoStart`) installs without starting the page, and
`--dir <folder>` (`-Dir <folder>`) installs somewhere else.

**Without the script.** Download `opencode-m365-copilot.zip` and its `.sha256` from the
[latest release](https://github.com/vincent1in/MS-Copilot-Code/releases/latest). Check the
zip with `shasum -a 256 -c opencode-m365-copilot.zip.sha256` on macOS and Linux, or compare
`Get-FileHash opencode-m365-copilot.zip` with the `.sha256` file in PowerShell. Then either:

- install it with the script, which checks it again and downloads nothing:
  `sh install.sh --zip opencode-m365-copilot.zip` (Windows:
  `powershell -ExecutionPolicy Bypass -File install.ps1 -Zip opencode-m365-copilot.zip`); or
- unzip it somewhere it can stay, and run `sh start.sh` (macOS, Linux) or double-click
  `start.cmd` (Windows) in that folder. OpenCode loads the gateway from this folder, so to
  update, unzip the new release and press Connect OpenCode on its page.

The zip holds everything that runs: the built gateway (`dist/`), Playwright for the sign-in
window, the source it was built from, and `SHA256SUMS` for every file. `BUILD-INFO.txt` says
which commit and Node version built it.

**Where releases come from.** Each release is built by this repository's Release workflow
(`.github/workflows/release.yml`) when its owner presses *Run workflow*. The workflow typechecks,
builds and runs every test with no route off the machine, builds the zip, checks that
`install.sh` installs it with no network, publishes it, and then runs both install commands
on Linux, macOS and Windows. Each release's notes link to the run that built it.

## What leaves your computer

**The gateway** connects to two addresses, both Microsoft's: `login.microsoftonline.com` to
sign in and refresh the token, and `substrate.office.com` for Copilot. Every other address is
refused in code (`src/egress.ts`), and CI runs the build and every test with no route off
the machine. It sends no analytics, checks for no updates and downloads nothing. Microsoft's
sign-in library (MSAL) adds its own name, version, operating system and CPU to each sign-in
and token request; the gateway takes those off, because signing in doesn't need them.

**What it sends to Copilot** is what OpenCode asks of it: your messages, the system prompt,
tool calls and their output, and attached images. Two settings, both off by default, add to
that. With Bing web search on, Copilot may turn parts of your code into Bing searches on
Microsoft's side. With MCP tool search on, Copilot is sent the names, descriptions and
arguments of the MCP tools it searches for ([MCP tools](#mcp-tools)). The page's Traffic tab
shows every message exactly as it was sent.

**The install command** contacts GitHub only, to download the release
([Installing and updating](#installing-and-updating)). The gateway never updates itself: run
the command again to update.

**The sign-in window** is Edge or Chrome on Microsoft's sign-in page, which loads what it
needs from Microsoft, and from your company's sign-in provider if it has one. The window has
its own profile, apart from your everyday browsing. Browsers also contact their makers on
their own: measured with Chrome 153, a sign-in window left open for 90 seconds called three
Google services (an account check, a push-messaging check-in and component updates). The
gateway turns those off when it opens the window, and the same test then found no outside
connection at all. Edge wasn't available to measure; its own Microsoft services follow your
organization's Edge policies. To check your own browser, run `node dist/cli.mjs doctor --browser`:
it opens the sign-in browser on an empty page for a minute and lists everything it tries to
contact by itself, refusing all of it.

**Local only.** The gateway and its page listen on 127.0.0.1 and refuse to start on any
other address, so nothing on your network can reach them. A request naming any other host
is refused too, so a web page can't reach them through DNS tricks either. The page's
Traffic and Checks stay in memory. The page writes your settings
(`~/.config/opencode-copilot/settings.json`), and OpenCode's config only when you press
Connect OpenCode.

**Checked four ways.** `scripts/sealed-network/run.sh` (Linux, as root) runs the gateway in
a sealed network whose only way out is a virtual cable to a recorder. The recorder answers
every name lookup with itself and logs every lookup, connection and TLS server name. The
same run records every connection attempt in Node and every network system call (strace),
and probes every port the gateway listens on from outside. The run covered:

- not signed in: help, doctor, setup, the page, a setting, Connect and a test message;
- the gateway as OpenCode loads it;
- signed in, with a fresh token and with an expired one;
- the sign-in window, open for 45 seconds.

| What ran | What left the machine |
|---|---|
| Not signed in: every command and the whole page, including Connect | **nothing** |
| Inside OpenCode, without signing in | **nothing** |
| A test message, signed in | one lookup of, and one TLS connection to, `substrate.office.com` |
| The same, with an expired token | one lookup of, and one TLS connection to, `login.microsoftonline.com` |
| The sign-in window (Chrome) | only `login.microsoftonline.com` |
| Connecting to the gateway from outside | refused on every port |

All four records agree on every row. Nothing else was looked up or contacted.

To watch it yourself on any system, start the gateway with Node's recorder:
`NODE_OPTIONS="--require ./scripts/net-guard.cjs" NET_GUARD_LOG=net.jsonl node dist/cli.mjs start`.
In PowerShell, run `$env:NODE_OPTIONS="--require ./scripts/net-guard.cjs"; $env:NET_GUARD_LOG="net.jsonl"`
and then `node dist/cli.mjs start`. Every connection attempt is then written to `net.jsonl`. To check what it listens on, run
`lsof -iTCP -sTCP:LISTEN -P | grep node` on macOS and Linux, or
`Get-NetTCPConnection -State Listen -OwningProcess (Get-Process node).Id` in PowerShell.
Only `127.0.0.1` should appear.

**OpenCode itself** is not covered by this review and has its own outside traffic. Its config
switches some of it off; these are the page's optional lines: `"update": "disable"` (update
checks), `"share": "disabled"` (session sharing) and `"websearch": false` (its web search
tool). Other OpenCode features can reach out or fetch tools when you use or configure them:
language servers and formatters (`lsp`, `formatter`), MCP servers, `skills` and
`instructions` given as URLs, and Git `references`. In OpenCode 2.2.6's packages, its
OpenTelemetry export runs only once you configure an endpoint. For the rest, such as how it
gets its list of models, see OpenCode's own documentation.

**npm** isn't needed for the release. In a source checkout, `.npmrc` turns off npm's update
check, funding notices and the dependency report it would send on every install, and never
runs install scripts.

## How it works

M365 Copilot has no developer API. It is an undocumented SignalR-over-WebSocket service
(`substrate.office.com`) that Microsoft intends only its own clients to speak to. This
package implements that protocol, wraps it in an OpenAI-compatible proxy, and ships an
OpenCode plugin that starts the proxy in-process and registers it as a provider.

```
opencode ──OpenAI /v1──▶ in-process proxy ──SignalR/WS──▶ M365 Copilot
                              │
                              └── local-title model, answered without any M365 call
```

## From source

Needs Node 22+ and git. Every step says what it downloads.

```sh
git clone https://github.com/vincent1in/MS-Copilot-Code.git
cd MS-Copilot-Code
npm ci --ignore-scripts      # exactly the locked versions from registry.npmjs.org, Playwright included; no install scripts
npm test                     # typecheck + suite, with all non-loopback network blocked
npm run build                # writes dist/
sh start.sh                  # the same page as the release
```

`scripts/release.sh` builds the release zip from a clean checkout.

The page's instructions and `setup` only ever point OpenCode at this folder, never at an
npm package name, so OpenCode cannot fetch anything from the registry for this plugin.
`setup` also replaces an upstream `opencode-m365-copilot` entry if it finds one. The
provider, the model list and the default model are all registered by the plugin at
startup. After pulling changes, re-run `npm ci --ignore-scripts && npm test && npm run build`.

Needs **opencode 2** — from 2.0.0 the major version tracks it. On opencode 1, stay on
0.4.x — see [opencode 1](#opencode-1).

## The thing you need to know first

**M365 refuses to work with a full coding-agent toolset.** Its "Disengaged" filter
returns an empty reply — indistinguishable from rate limiting unless you look for
`messageType: "Disengaged"` — and the reference reverse-engineering notes measure the
threshold at roughly 12 tools, naming opencode specifically as the harness that
disengages *persistently*.

So this plugin's main job is not wiring. It is **cutting opencode down to something M365
will engage with**. Measured against opencode 1.18.18 on a single agentic turn:

| | stock | with this plugin |
|---|---|---|
| tools offered | 9 | 4 |
| prompt sent to M365 | 53,676 chars | 9,701 chars |
| `<available_skills>` catalogue | 34,263 chars | removed |

The trimming is on by default. Turn it off with `{ "lean": false }` and expect empty
replies.

## Where the trimming happens, and why

Not in opencode's config — **in the proxy**. Two opencode levers look like they should
work and do not (verified against 1.18.18, and the reason the architecture is what it is):

- **`config.tools`** is resolved into the config — `opencode debug config` shows it
  correctly — but the request still offers every tool. A config disabling eight tools
  produced a request offering all nine.
- **`experimental.chat.system.transform`** fires, and accepts a replacement `system`
  array, but the request that reaches the provider still carries the original prompt.
  Setting `agent.<name>.prompt` from the `config` hook is ignored the same way.

The proxy sees the final request, so it is the one place the trim reliably lands.

What gets dropped:

- **Tools** — keeps the shell tool under whatever name the harness gives it (`shell`
  in opencode 2, `bash` before), `read`, `grep`, and the editing tools (`edit`/`write`,
  or `apply_patch`). On opencode 2.2.5 that is five of thirteen; `execute`, `glob`,
  `skill`, `subagent`, `webfetch`, `websearch` and `question` are dropped.
- **Capability catalogues** — `<available_skills>` is removed when no `skill` tool
  survives the trim, because it advertises capabilities nothing can invoke. `<env>` and
  other structured context are kept.
- **Text about dropped tools** — opencode 2's "Code Mode" section says the listed tools
  only work inside `execute`, which the trim removes, so the model was being told its
  tools were unusable. That section, any line naming `execute`, and the skills
  paragraph go with their tools, as do two harness lines that contradict the
  contract ("prefer parallelizing tool calls", "prefer dedicated tools over shell
  commands"). The whole Code Mode section is removed, catalogue included, even when a
  tool's description in it holds a line that looks like a heading. On opencode 2.2.5
  this takes the system prompt from about 8,000 characters to about 2,000. To reach
  MCP tools anyway, see [MCP tools](#mcp-tools).
- **The harness's prose system prompt** — replaced with a short one, but **off by
  default**. A long, polished assistant prompt measurably reduces M365's tool
  compliance on another harness's numbers; that is a borrowed result we have not
  reproduced, so it is opt-in via `{ "leanSystemPrompt": true }`. Your own rules are
  never dropped either way: opencode injects `AGENTS.md` and global rules as prose
  inside the system message, and those sections are preserved verbatim.

The shell tool is never dropped. M365's chat-tuned model will not "act as an agent" on request,
but it *will* reflexively write a ```` ```bash ```` block — routing that block to the
shell tool is the single lever that makes tool calling work at all.

## How tool calling works

M365 has no native `tool_calls`. Tools go out as a fenced contract and come back as
fenced blocks:

````
```read
filePath: /etc/hostname
```
````

Scalar arguments are `key: value` header lines, one free-form argument is the fence body,
and an old/new pair is written as a SEARCH/REPLACE diff. A JSON `{"tool": …}` contract
was tried in the reference project and scored 0/5 on real agentic tasks.

Every tool turn runs agent-less: the fenced contract goes out with every request, and the
default model `gpt-6.1-sol` uses the user-voice `relay` framing measured to work agent-less
(see [Models](#models)). Upstream could also route tool turns through a Copilot Studio
agent that it created and published in your tenant. This fork removed that, so nothing is
ever created in your tenant and no Power Platform token is requested.

Four things keep a turn on track:

- **A tolerant parser.** M365 writes calls loosely: the command as a `command:` header,
  `filePath:` for `path`, quoted values, a copied `$ ` prompt, a fence opened at the end of a sentence (`…first.```shell`), prose or an invented
  `<tool_response>` after the block. These are read as the call the model meant.
- **One nudge after a give-up.** Chat tones sometimes answer a tool turn with "no tool
  is available" without trying. The proxy then asks once more, softly, in the same
  conversation (one extra message, no new conversation), worded differently once
  tools have already run.
- **A pinned backend.** Every turn's connection carries
  `X-RoutingParameter-SessionKey`, which the reference project found stops long
  sessions running on a forked copy of the conversation.
- **Telling the model what ran.** Only the first tool block in a reply runs. When a
  reply holds more, or goes on to predict its own result, the next turn starts with
  one line saying so, so the model does not assume the rest ran. opencode's tool
  errors arrive as plain text (`Error: …`) rather than a JSON envelope. In the 237
  `quick` turns measured so far, no reply needed the note.

Measured on one tenant on 2026-11-09 (`m365/quick`, opencode 2.2.5, 36 conversations,
alternating builds), with and without the prompt trimming, nudge and routing header.
Both builds had the tolerant parser:

| Task | Without | With |
|---|---|---|
| Fix a bug, then rerun its test | 6/6, 5.3 turns | 6/6, 5.0 turns |
| Find a value across six files | 6/6, 2.7 turns | 6/6, 2.0 turns |
| Edit one config value, leave the rest | 6/6, 3.5 turns | 6/6, 4.5 turns (re-read the file to check, 3 of 6) |

Every run made its tool call on the first turn, so the nudge never fired. No turn
disengaged, and none ran on a forked conversation (`turnCount` rose by one each turn).

Long sessions (2026-11-10, `m365/quick`, with all three): 4/4 solved, no nudges, no
forks.

| Task | Runs | Turns |
|---|---|---|
| Rename a function across ten modules, one edit at a time, then run the test | 2/2 | 37, 25 |
| Fix a 1,500-line file whose test fails, then fails again on a second bug | 2/2 | 8, 8 |

`turnCount` rose by one on every turn of the 37-turn session. Repeated calls were
progress checks (grep for what was left, re-reading a file after editing it), not loops.
These runs had the routing header, so they show it causes no harm. They don't show it
is needed, because no run without it was tried.

## MCP tools

opencode 2 does not offer MCP tools as ordinary tools. It lists them in a **Code Mode**
catalogue in the system prompt (`tools.github.create_issue({ … })` and so on, with
opencode's own `opencode` namespace among them), and they can be called only as
JavaScript inside its `execute` tool. The request's `tools` hold opencode's built-ins
plus `execute`, whose one parameter is a string of code. The lean trim drops `execute`
and the catalogue goes with it, so **by default Copilot is shown no MCP tools at all**:
not their names, not their descriptions. Offering the catalogue as it is would also put a
long list of TypeScript signatures in front of M365 and push it back towards the
Disengaged threshold.

**MCP tool search** (the Settings page; or the `mcpProxy` plugin option, or
`M365_MCP_PROXY=1`) is off by default and marked experimental. Turned on, the proxy stands
in for the catalogue. M365 never sees `execute` or the catalogue, even with `lean` off: the
catalogue is stripped from the prompt, and the proxy adds **one** extra fenced tool, `mcp`,
as the only way to reach the MCP tools.

**What Copilot then receives.** The `mcp` tool's one-line description summarises what is
behind it, by server, so the model knows a search is worth making:

```
mcp — Use 14 tools from my MCP servers — github (create_issue, list_issues, search_code, get_file, +6 more), slack (post_message, list_channels) — by searching with a few words about what you want to do; …
```

It names up to four tools for each server and up to eight servers. When Copilot searches,
the gateway sends it the matching tools' signatures and descriptions, as opencode wrote
them. When it calls one, opencode runs the call and its result goes back to Copilot like
any other tool's result. All of it goes to `substrate.office.com`, like the rest of the
conversation, and the page's Traffic tab shows each message.

A search looks like this:

````
```mcp
search: create a github issue
```
````

The proxy answers that search **itself**; it never reaches opencode. It ranks the
catalogue against the words (a hit in a tool's name counts more than one in its
description) and sends the best five back to M365 in the same conversation: each
match's signature as opencode wrote it, then how to call one. A search for a server's
prefix, such as `github.`, lists that server's tools, also up to five. The model then
calls a tool through `mcp` with `call:` and the path the search showed, and its
arguments as a JSON object:

````
```mcp
call: tools.github.create_issue
{"owner": "me", "repo": "project", "title": "The build fails on Node 22"}
```
````

Scalar arguments may instead be written as `key: value` lines, like any other fenced
tool; a value that reads as a JSON number, boolean or null is passed as one:

````
```mcp
call: tools.github.get_issue
owner: me
repo: project
issue_number: 42
```
````

The proxy turns that block into an `execute` call for opencode to run, with the code
`return await tools.github.create_issue({"owner":"me",…});`. opencode asks you first if its
permission settings say so, as for any tool, and its result comes back to M365 as an
ordinary tool result. In the history M365 is sent, those `execute` calls are written back
as the `mcp` blocks it wrote. A path that is not in the catalogue, or a block the proxy
cannot read, is answered in the proxy with a short note on what to write instead; nothing
reaches opencode. M365 sees the lean set plus one tool however many MCP tools you have.

When opencode marks its catalogue as **partial** (it lists only some of its tools and
offers a `search(...)` function for the rest), a search that matches nothing in the
listed part goes to opencode's own search instead, as an `execute` call with the code
`return await search("…");`. Its result comes back as a tool result, and a
well-formed `tools.…` path it returns may then be called even though the catalogue does
not list it.

- **Cost.** Each search answered in the proxy is one extra M365 message in the same
  conversation, like the give-up nudge; it does not start a new conversation. So is the
  note for an unknown path or an unreadable block.
- **Cap.** At most 3 searches per request, counting those notes. A reply that is still
  an `mcp` block after the third is returned as its prose, and an `mcp` block never
  reaches opencode as an `mcp` tool call.
- **Not yet measured on a live tenant.** The flow is covered against the offline stub
  only; whether M365 searches and then calls reliably has not been measured.

On the page, each search and its answer show under the turn, and the Checks tab notes what
the gateway did. With `M365_TURN_LOG` set, each search is also a turn of its own in the
log, marked with `mcpSearch` and the query. A turn whose reply became an `execute` call is
marked with `mcpCall` and the tool's path, or `search` when it went to opencode's own search.

## opencode 2

This is an opencode 2 plugin (`@opencode/cli`, `@opencode/plugin`): its default export
is `{ id, setup }`. A local checkout is referenced by its **directory** — opencode 2
drops a file path with `configured plugin path must be a directory`, and since it
swallows plugin load failures, nothing else tells you. `opencode-m365 setup` writes the
right reference for you.

Everything in [Where the trimming happens](#where-the-trimming-happens-and-why) still
lives in the proxy. opencode 2 does offer hooks where opencode 1's were dead
(`ctx.tool.transform`, `session.hook("context")`); neither has been measured against a
live tenant, so the proxy stays the enforcement point.

### opencode 1

opencode 1 is not supported by this fork. Upstream's **0.4.x** is the last release that
loads there, but it is the unreviewed upstream npm package, so it is out of scope for this
fork. 2.0.0 and later under opencode 1
fail to load with `must default export an object with server()`. Re-running
`opencode-m365 setup` removes this plugin's entry from opencode 1's `plugin` key, keeping
any options you set on it, and leaves other plugins' entries alone.

### Verified how far

Against a real opencode 2.2.5, end to end, with the proxy running against the offline
stub rather than Microsoft: the plugin loads from a directory, registers the whole model catalogue,
an attached image is uploaded and attached to the turn, and the session title is
answered locally — one chat turn reaches the backend, not two. The catalog records are
also checked against the real `@opencode/plugin` schema constructors in the test suite.
That stub run says nothing about Microsoft's side; see [Development](#development) for what has been run live.

## Settings

Every setting is on the page's **Settings** tab, in plain words, and saved in
`~/.config/opencode-copilot/settings.json` (readable only by you). The gateway inside
OpenCode reads the same file. Changes apply from the next message; *When OpenCode starts*
applies the next time OpenCode starts.

| Setting | Default | Plugin option | Environment variable |
|---|---|---|---|
| When Copilot uses your work data | hold the reply | `workIq` | `M365_WORK_IQ` |
| Bing web search | off | `webSearch` | `M365_WEB_SEARCH=1` |
| MCP tool search (experimental) | off | `mcpProxy` | `M365_MCP_PROXY=1` |
| Trim OpenCode's tools | on | `lean` | |
| Write session titles on this computer | on | `setSmallModel` | |
| Short system prompt | off | `leanSystemPrompt` | |
| Default model in OpenCode | on | `setDefaultModel` | |
| When OpenCode starts (this page) | off | `monitor: true` starts it | `M365_MONITOR=1` |
| Browser for signing in | Edge, else Chrome | | `M365_BROWSER_CHANNEL`, `CHROMIUM_PATH` |

You don't need the plugin options or the environment variables. If you set them, an
environment variable wins over a plugin option, which wins over the page; the page then
shows the setting as locked and says where it is set. Plugin options go on the gateway's
entry in OpenCode's config:

```jsonc
{
  "plugins": [{
    "package": "/path/to/opencode-m365-copilot",   // this folder
    "options": {
      "workIq": "hold",          // "hold" | "flag" | "allow"
      "mcpProxy": false,         // MCP tool search through one `mcp` tool (default: false)
      "baseUrl": null,           // use an already-running proxy on this machine (loopback only)
      "apiKey": null             // that proxy's secret (or export M365_PROXY_KEY instead)
    }
  }]
}
```

The in-process proxy needs no key configured: it mints a random secret each launch and
hands it to opencode itself. Only a standalone `opencode-m365 serve` proxy needs one —
`serve` prints its key, or takes a fixed one from `M365_PROXY_KEY`. Either put that key
in `apiKey`, or export the same `M365_PROXY_KEY` to opencode and leave `apiKey` out.

### Errors and the turn log

When M365 refuses a turn, the proxy reports it so that opencode does not retry it.
Retrying a throttle only extends it, and a refusal like a missing licence never changes.
opencode streams, so the refusal usually arrives inside a stream that already answered
200. opencode then decides from the error body alone: it retries an error whose code
contains "unavailable", whose message says "try again" (M365's own refusals do), or
which mentions a rate limit. The proxy therefore sends type `invalid_request_error`,
avoids those words, and uses HTTP 422 when nothing has been streamed yet. In 2.2.0 a
licence refusal was retried ten times. The error `code` says which refusal it was:

| Code | Meaning |
|---|---|
| `m365_throttled` | The account is throttled. Wait for a lull. |
| `m365_not_served` | M365 answered with its own refusal: a model this licence does not cover (Claude without a Claude licence, say) or a dead tone. The `param` is `premium_licence_required` or `priority_access_exhausted` when M365 said it was one of those, which the included scenario this fork uses shouldn't produce. Called `m365_unavailable` up to 2.2.0 |
| `m365_turn_rejected` | The server refused the request outright, typically a retired tone |
| `m365_disengaged` | M365's filter refused to engage with the prompt. A disengaged conversation stays that way, so the proxy drops it: the next request opens a fresh conversation and replays the whole history |
| `m365_work_data_held` | Copilot drew on your work data (Work IQ) and the `workIq` policy is `hold`, so the reply was not passed on. The conversation is dropped as for `m365_disengaged`. See [Work IQ](#work-iq-your-work-data) |

Set `M365_TURN_LOG=/path/to/turns.jsonl` before starting opencode to record one line
per M365 turn: the raw reply, the tool calls parsed from it, and M365's diagnostics
(`contentOrigin`, `turnCount`, throttle and classifier scores). The file is
owner-only, and off by default because a reply can quote anything from the workspace.

### Why session titles are answered locally

opencode titles every new session with a model call on your main model, which on M365
would open a **second conversation** per session. The account-level throttle counts
conversations started, not messages, so that is the fastest way to get throttled.

opencode 2 has no `small_model` setting, and its title hook exposes the model read-only,
so the plugin marks the title request on a header (`x-m365-request-kind: title`) and the
proxy answers it locally, without opening a connection. Compaction and generation stay
on the real model — they are real work, and only titling opens the extra conversation.
`setSmallModel` turns this off; the name dates from opencode 1, where it set
`small_model`. Any OpenAI client can also select `m365/local-title` by id.

## The gateway's page

`opencode-m365 start` (or `start.sh`, `start.cmd`) runs a gateway with its page and opens it.
The page has four tabs: **Set up** (sign in, a test message, connecting OpenCode),
**Traffic**, **Checks** and **Settings**.

Inside OpenCode the gateway runs without a page unless you ask for one: under Settings,
*When OpenCode starts* can start the page, or start and open it. `opencode-m365 open`
opens the page of a gateway that is already running.

**Traffic** shows, turn by turn, what crossed between OpenCode, the gateway and Microsoft
365 Copilot. Each turn is laid out with this machine on the left and Microsoft 365 on the
right, so anything on the right has left the machine:

- **opencode sent**: the new messages (your prompt, tool output, the system prompt on the
  first turn), and which tools were passed on or left out.
- **Sent to Copilot**: the exact text Copilot received, the connection's host, path and
  parameters (never the access token), and the rest of the request envelope.
- **What Copilot did**: its searches, search results, progress notes and cards.
- **Copilot replied**: the raw reply, how long it took, which backend answered, the
  conversation's message budget, classifier scores and any sources it cited.
- **Handed to opencode**: the tool call or text opencode got, or why it got nothing.
- **Checks**: every outbound connection and whether the egress allowlist let it through,
  work data use, text that looks like a key or password in what was sent, the tool trim,
  give-up retries, refusals and dropped conversations. The Checks tab lists them all.

It is temporary. Records live in the gateway's memory, capped at 5,000 events and about
24 million characters, oldest out first. **Clear** wipes them, and so does stopping the
gateway. Nothing is written to disk. The page keeps its key in that browser tab's session
storage, so a reload works and closing the tab forgets it.

Prompts, replies and tool output are shown exactly as they were: that is the point. Key-like
text is marked, not altered, because it was sent as is. The gateway's own credentials are
never recorded.

The page is served by a second loopback listener, separate from the proxy, so the proxy's
"no browsers" rule is unchanged:

- It binds 127.0.0.1 only, and refuses any `Host` that is not a loopback name on its own
  port.
- The page is static and holds no data. The log needs a per-launch key, sent in an
  `Authorization` header. The key travels in the link's `#fragment`, which browsers
  never send to a server, and the page removes it from the address bar.
- Requests from other origins and sites are refused, preflights are never granted, and
  no CORS headers are sent.
- The content security policy allows only the page's own script and style. Responses
  forbid framing, sniffing, caching and referrers.
- Everything from opencode or Copilot is rendered as text, never as HTML.

`opencode-m365 open` (and `opencode-m365 monitor`, which prints the link) find the link in an
owner-only file under `~/.config/opencode-copilot/monitor/`. The file holds the link, not
anything the page shows, and is deleted when the gateway stops.

The page can also change things: save a setting, start a sign-in window, send the test
message, and add this folder to OpenCode's config when you press Connect OpenCode. Those
need the same key and take JSON only. Connect keeps the rest of OpenCode's config, saves a
`.bak` first, refuses a file that isn't valid JSON, and never rewrites an `opencode.jsonc`
(comments would be lost); then it shows the lines to add by hand.

## Work IQ (your work data)

Work IQ is Microsoft's name for Copilot drawing on your Microsoft 365 work data:
email, files, chats, meetings and people. In Copilot Chat it is a single on/off button
that replaced the separate Work and Web tabs. It comes only with the Microsoft 365
Copilot add-on licence, and is on by default for those users.

This gateway never asks for it. It uses the full-screen Copilot Chat scenario with no
plugins, and the mailbox-grounded scenario is removed. Whether Microsoft applies Work IQ
to such a turn anyway has not been verified against a live tenant. So every turn is
checked for evidence instead:

- **What counts as evidence:** Copilot's structured traffic only. That means its search
  messages (`InternalSearchQuery`, `InternalSearchResult`, reference cards) and the
  answer's source attributions, placed by the name of the search call and by the host of
  each source.
- **What doesn't:** the reply's own text. A SharePoint URL that is in your code is not
  grounding.

What happens next is the *When Copilot uses your work data* setting (or the `workIq` plugin option, or `M365_WORK_IQ`):

| Policy | A reply drawn from work data | A search the gateway can't place | Web sources while Bing is off |
|---|---|---|---|
| `hold` (default) | **Held**: opencode gets `m365_work_data_held` instead of the reply, and the conversation is dropped | Flagged | Flagged |
| `flag` | Passed on, flagged in Checks | Flagged | Flagged |
| `allow` | Passed on, noted | Noted | Noted |

Under `hold`, tool-less replies are buffered rather than streamed, because the evidence
can arrive with the last frame. Every turn is checked whether or not the page is running.
On the page, each turn shows what Copilot searched and cited. If you turned on
`M365_TURN_LOG`, that debug file still records the raw reply of a held turn, as it
records every reply.

**What your organisation can see.** Microsoft's audit log for Copilot records each
interaction:

- its message IDs;
- the files Copilot accessed, with their sensitivity labels;
- the plugins it used (for example `BingWebSearch`);
- whether a jailbreak or cross-prompt injection was detected.

The text itself can be kept under your organisation's retention policies. Everything on
the page's Microsoft 365 side is what reaches that record.

## Models

Models are selected by an M365 *tone*, not a model id. **In this fork `m365/gpt-6.1-sol` is
the default** (upstream's is `m365/quick`): tool turns run agent-less here, where the
reference project measured GPT-6.1 Sol and GPT-6 Sol under the
`relay` framing at 39/40 and 60/60 on its bench, and 30/30 driving a real agent, on accounts
with no paid Copilot seat. Both serve on every work account with Copilot Chat. They are
reasoning tones, so expect 10–30 s a turn. These figures are the reference project's, not
yet re-measured through this fork.
The upstream measurements below are kept as they were.

### Every model

Every model here goes out on M365's included scenario (`OfficeWebIncludedCopilot`), the
one a Copilot Chat licence covers. None is metered or billed to Copilot credits
([What it costs](#what-it-costs)). Every tool turn runs agent-less; the last column says how
it is worded ([Tool turns per model](#tool-turns-per-model)).

| Model | What it is | Tool turns |
|---|---|---|
| `gpt-6.1-sol` | GPT-6.1 Sol, reasoning. **The default** | relay, sandbox note |
| `gpt-6.2-sol` | GPT-6.2 Sol, reasoning. Its tool use is not yet measured | relay, sandbox note |
| `gpt-6-sol` | GPT-6 Sol, reasoning | relay, sandbox note |
| `gpt-5.6-think-deeper` | GPT-5.6, reasoning | relay |
| `gpt-5.5-think-deeper` | GPT-5.5, reasoning | relay |
| `m365-copilot` | M365 Copilot's own choice (Auto) | default |
| `quick` | GPT-5.5, chat. Upstream's default | default |
| `gpt-5.6-quick` | GPT-5.6, chat. Writes tool calls far less often | default |
| `claude-sonnet` | Claude Sonnet 4.6 | relay |
| `claude-sonnet-think-deeper` | Claude Sonnet, reasoning | relay |
| `gpt-5.4-think-deeper` | GPT-5.4, reasoning | relay |
| `gpt-5.4-quick` | GPT-5.4, chat | default |
| `gpt-5.3-quick` | GPT-5.3, chat | default |
| `gpt-5.3-think-deeper` | GPT-5.3, reasoning | relay |
| `gpt-5.2-quick` | GPT-5.2, chat | default |
| `gpt-5.2-think-deeper` | GPT-5.2, reasoning | relay |
| `local-title` | Session titles, answered by the gateway with no M365 call | none |

The scenarios and routes come from the reference project's measurements
([cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy),
`docs/m365-copilot-api.md` §5 and quirks #21 and #25). They have not been measured live
in this gateway.

### Aliases

Each model is listed once. Some ids used to appear alongside a twin that selects the same
tone, so the picker showed the model twice, and Claude Sonnet is also accepted by version.
These ids are not listed, but they are still accepted, with or without the `m365/` prefix:

| Accepted, not listed | Listed as |
|---|---|
| `auto` | `m365-copilot` |
| `claude`, `claude-sonnet-4.6`, `claude-sonnet-4.5` | `claude-sonnet` |
| `gpt-5.5`, `gpt-5.5-quick` | `quick` |
| `gpt-5.6` | `gpt-5.6-quick` |
| `think-deeper` | `gpt-5.5-think-deeper` |
| `gpt-5.4` | `gpt-5.4-think-deeper` |
| `gpt-5.3` | `gpt-5.3-quick` |
| `gpt-5.2` | `gpt-5.2-quick` |

A saved default model that names one of these is moved to the listed id at startup, since
opencode only loads a default its catalogue lists.

### Not in this fork

**Models that cost something.** Upstream 2.4 added models that need a premium Microsoft
365 Copilot licence, M365's paid scenario, or Copilot credits: GPT-6.2 Astra, GPT-6 Astra,
GPT-6 (Think Deeper), Claude Opus 5.5 and 4.8, Claude Sonnet 5.5, Claude Sonnet 5 and
Claude Fable 5.1 ([What it costs](#what-it-costs) says which costs what). None is listed
here, and the gateway never sends the paid scenario (`OfficeWebPaidCopilot`) or a
`licenseType`: every request goes out on the included scenario, whatever model it names. A
request for one of those ids, from an old config say, is answered by the default model.

**Mailbox-grounded models.** Upstream's `m365/work` and `m365/work-think` (Copilot
searching your mail, Teams and files server-side through the Outlook side-pane scenario,
which also sent an `EnableStarterLicenseCheckBypass` feature flag) are removed. Every model
here is a coding model and never grounds on your account's content.

### Tool turns per model

Upstream can attach its Copilot Studio agent to a tool turn. This fork removed the agent,
so every tool turn runs agent-less, and the tone you pick is the model that answers. What
changes from tone to tone is how the tool block is worded:

- **Chat GPT tones** (`quick`, `m365-copilot`, the `-quick` models) get the default framing.
- **Reasoning GPT tones** get the relay framing (below).
- **The Sol tones** (GPT-6, 6.1 and 6.2 Sol) get the relay framing with one more line:
  agent-less, they run commands in a remote sandbox of their own, so the note names its
  tools and asks for your terminal instead.
- **Claude** gets the relay framing too, since 2.5.0. Upstream 2.4 moved Claude there after
  the reference project found that agent-less Claude makes tool calls reliably that way.
  On an account with no Claude licence, M365 refuses Claude's tool turns
  (`ClaudeUnavailableForLicense`), and opencode gets `m365_not_served`.

Tool-calling on a live tenant (2026-11-09, one non-Premium account, a single file-read
task per run; small samples; upstream, with its agent):

| Model | Made the tool call |
|---|---|
| `m365/quick` | 5/5 |
| `m365/m365-copilot` | 1/1 |
| `m365/gpt-5.5` (same tone as `quick`, now an alias of it) | 0/1 |
| `m365/gpt-5.6` | 0/1 (the reference project: 7/30), so its picker name says "unreliable tool calls" |
| `m365/gpt-5.5-think-deeper` | 0/3 — said it had no file tool; 4/4 with the relay framing, below |

The reference project's README reports 100% tool compliance for `gpt-5.5-think-deeper`;
its protocol notes (`m365-copilot-api.md`, quirk #13) say reasoning tones disengage with
an agent attached. Our runs agree with the notes. Reasoning tones still serve plain chat.
No other model's tool calling has been measured here.

The reasoning tones and Claude get a different framing on tool turns. The tool block is
worded as the user asking to be guided through their own terminal, one command at a
time, pasting back the real output (the reference project's `relay`). A model that
doubts it can reach the workspace has nothing to doubt, because the user runs the
commands. Measured on `gpt-5.5-think-deeper` on 2026-11-10, 16 conversations:

| Framing | First reply said the tools were unavailable | Solved |
|---|---|---|
| Default, before the give-up nudge | 4/4 | 1/4 |
| Default, with the nudge | 8/8 | 5/8 |
| Relay, with the nudge | 0/4 | 4/4, with no nudge needed |

## What it costs

Nothing beyond your Copilot Chat licence. Every listed model is on M365's included
scenario, which the reference project's protocol notes record as carrying no metering and
no Copilot credits ([cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy),
`docs/m365-copilot-api.md` §5 including its priority-access sections, §7 "Throttling &
quotas", and quirks #11 and #26). None of this has been measured from this gateway.

| Model | Access | Cost |
|---|---|---|
| `gpt-6.1-sol` | included | included |
| `gpt-6.2-sol` | included | included |
| `gpt-6-sol` | included | included |
| `gpt-5.6-think-deeper` | included | included |
| `gpt-5.5-think-deeper` | included | included |
| `m365-copilot` | included | included |
| `quick` | included | included |
| `gpt-5.6-quick` | included | included |
| `claude-sonnet` | included | included |
| `claude-sonnet-think-deeper` | included | included |
| `gpt-5.4-think-deeper` | included | included |
| `gpt-5.4-quick` | included | included |
| `gpt-5.3-quick` | included | included |
| `gpt-5.3-think-deeper` | included | included |
| `gpt-5.2-quick` | included | included |
| `gpt-5.2-think-deeper` | included | included |
| `local-title` | none | free: answered by the gateway, no M365 call |

Aliases cost the same as the model they point at ([Aliases](#aliases)).

**Left out because they cost something** ([Not in this fork](#not-in-this-fork)), per the
same notes:

- **Copilot credits on every turn:** Claude Fable 5.1, GPT-6.2 Astra and GPT-6 Astra.
- **A priority-access allowance**, on the paid scenario: Claude Opus 5.5 (40 turns a day,
  75 a week) and Claude Sonnet 5.5 (80 a day).
- **A premium licence:** GPT-6 (Think Deeper), GPT-6 Astra, Claude Sonnet 5 and the two
  above on the paid scenario, and Claude Opus 4.8 on the included one.

GPT-6.1 Sol and GPT-6.2 Sol have priority-access budgets too, but only on the paid
scenario. On the included scenario, the only one this gateway sends, they carry none.

**Limits on every model.**

- **600 user messages per conversation.** Every "continue" retry, give-up nudge and
  `mcp` search answered in the proxy counts as one, and so does a cancelled turn. The
  gateway reuses one conversation per opencode session and sends only the new messages
  (delta mode), and reports what is left in `usage.x_m365_conversation_remaining`.
- **An account-level throttle on conversations started.** It is why session titles are
  answered locally ([Why session titles are answered locally](#why-session-titles-are-answered-locally)).
  Heavy use degrades into Disengaged or empty replies, which recover after a lull of
  about 15 minutes. Signing in again does not clear it.

## Context and budget in the UI

opencode shows two things for a session on an `m365/*` model. Both are estimates or
snapshots, not a bill.

**The context meter (opencode's own).** M365 reports no token counts, so the proxy
estimates them at about four characters per token, rounded up. `prompt_tokens` is the
size of the whole context opencode sent for the request (every message, plus the tool
definitions), not the smaller delta M365 actually received, because the meter wants the
size of the context opencode holds. Each attached image counts a fixed 85 tokens.
`completion_tokens` is the reply's text, or the tool call's name and arguments. The
usage is marked `x_m365_tokens_estimated: true`, and a streamed reply carries it in a
final chunk when the request sets `stream_options.include_usage`, which opencode does
by default. Treat the meter as a rough guide: the real tokenizer, and whatever M365
adds on its side, are invisible here.

**The status line.** The footer (the TUI `prompt.footer.status` slot) shows the
conversation's message budget:

```
M365 12/600 msgs
```

The sidebar (`sidebar.content`) lists the model, the conversation's messages, the
estimated context tokens, the turns this session, and the last refusal until a later turn
is answered. A part with no data yet is left out, and a session on another provider shows
nothing.

| Shown | Source |
|---|---|
| `12/600 msgs` | M365's `throttling` on every turn: messages used in this session's conversation, out of its 600 cap (the same figure as `usage.x_m365_conversation_remaining`) |
| Context tokens | The estimate above, from the last request |
| Turns | M365 turns this session; a nudge or an answered `mcp` search counts as one |
| Refusal | The last premium-licence or priority-access refusal, should M365 send one |

The status can also show a priority-access allowance and turns billed to Copilot credits,
which upstream's paid models report. No model here has either, so they never appear.

The proxy keeps these figures in memory per opencode session (the 200 most recently
used), for its own lifetime only, and sends them nowhere. The TUI half of the plugin (the
package's `./tui` export, loaded from the same plugin reference) reads them over opencode's
RPC domain as `m365-copilot.metrics`: when a session first appears, when the proxy
announces a change, and when a model step ends or fails. Nothing polls. Attached to an
external proxy with `baseUrl`, which must be on this machine, the plugin reads the same
figures from `GET /v1/m365/metrics/<sessionID>`, behind the proxy's bearer secret. The TUI
draws with the Solid runtime opencode provides to plugins; if a host lacks it, the status
is simply absent and the provider still loads.

## Authentication

Sign-in happens on the page (Set up, step 1) or with `opencode-m365 login`, never inside
OpenCode: the plugin only refreshes silently, and asks you to sign in on the page if it
cannot. A plugin running underneath a TUI has no business opening a browser.

Sign-in is **interactive only** in this fork: a visible browser window opens and you
complete SSO/MFA by hand, once. Upstream's automated mode (a stored password plus TOTP seed
in `secrets.json`) is removed — a file holding both factors lets anyone who can read it pass
MFA as you. If an old `secrets.json` is still on disk, `doctor` tells you to delete it;
nothing reads it.

The window uses a browser you already have: Edge, else Chrome, or the one you pick under
Settings. `M365_BROWSER_CHANNEL=msedge` (or `chrome`) or `CHROMIUM_PATH=/path/to/browser`
override that. Playwright's own Chromium is used only if you installed it yourself
(`npx playwright install chromium`); nothing downloads a browser for you. The window keeps
its own profile in `~/.config/opencode-copilot/browser-profile/`, and the gateway switches
off the browser's own background services before it opens (see
[What leaves your computer](#what-leaves-your-computer)).

It is one-time; afterwards tokens refresh from the MSAL cache.

The client id is Microsoft's own Office web Copilot application. That is not a shortcut —
the Sydney scopes are granted to no other client, so a loopback redirect is rejected
(`AADSTS50011`) and the device-code grant demands a client secret only Microsoft holds
(`AADSTS7000218`). Driving a browser is the only door.

State lives in `~/.config/opencode-copilot/` — deliberately not `~/.config/opencode-m365/`,
which belongs to the m365-copilot-proxy project.

## CLI

```sh
opencode-m365 start [--port 4141] [--no-open]
                                      # the gateway and its page: set up, traffic, settings
opencode-m365 open                    # open the page of a gateway that is already running
opencode-m365 login                   # sign in (browser window, SSO/MFA by hand)
opencode-m365 setup [--quiet]         # add this folder to OpenCode's config, keeping a backup;
                                      # --quiet also turns off OpenCode's update checks,
                                      # session sharing and web search
opencode-m365 serve [--port 4141]     # only the proxy, for any OpenAI client
                                      # (send its key as `Authorization: Bearer`)
            [--monitor]               # ...and the page; prints its link
opencode-m365 monitor                 # print the page link of each running gateway
opencode-m365 doctor [--live]         # check sign-in, the proxy and OpenCode (read-only;
                                      # --live sends one short message per model tone)
            [--browser]               # ...and list what the sign-in browser contacts by
                                      # itself in a minute (refused, not sent)
```

In the release folder these are `node dist/cli.mjs <command>`.

## Images

Paste an image into opencode (or attach one with `opencode run -f shot.png`) and the
model sees it. opencode sends it to the proxy as an `image_url` data URL; the proxy
uploads it to M365 the way the Copilot web client does — `POST /m365Copilot/UploadFile`
into the same conversation — and the turn points at the upload with an `ImageFile`
annotation. Only images new to a turn are uploaded: M365 already holds the earlier ones.

- If an upload fails, the turn still runs and the model is told the image did not
  arrive, so it says so instead of describing a picture it never saw.
- Data URLs only. A remote `https://` image URL is not fetched.
- The local titler model stays text-only; it never reaches M365.
- The M365 side is implemented from cramt/m365-copilot-proxy's measurement (one model,
  agent attached and not); like the rest of this README's M365 claims, it has not been
  run against a live tenant from here.

## Limits

- **600 user messages per conversation** (see [What it costs](#what-it-costs)). The proxy reuses one conversation per task,
  sends only new messages, and reports the remaining budget in
  `usage.x_m365_conversation_remaining`. A task is the opencode session on opencode 2,
  or the system prompt plus the first user message otherwise; turns within one task run
  one at a time.
- **Account-level throttling** exists and is keyed to your identity, so re-authenticating
  does not clear it. It self-heals after a lull.
- **Streaming** works for tool-less turns when `workIq` is `flag` or `allow`. A tool turn
  is buffered, because a fenced call cannot be parsed until the fence closes; under the
  default `hold`, tool-less turns are buffered too (see [Work IQ](#work-iq-your-work-data)).
- **Tool calling is emulated**, not native, and one call per turn is kept by default —
  M365 batches its whole plan into one response, and later steps run on guessed state.
- `usage` holds estimated tokens, marked `x_m365_tokens_estimated: true`
  ([Context and budget in the UI](#context-and-budget-in-the-ui)): M365 never exposes token
  counts. The `x_m365_*` extension fields carry what it does report, including
  `x_m365_dea_score`, the classifier score that rises before the Disengaged filter fires.

## Development

```sh
npm ci --ignore-scripts
npm test           # typechecks, then runs the suite; non-loopback network is blocked (test/net-guard.setup.ts)
npm run build
```

To audit a whole command, not just the tests, preload the guard into every Node process it
starts and read the log:

```sh
NODE_OPTIONS="--require ./scripts/net-guard.cjs" NET_GUARD_LOG=/tmp/net.jsonl NET_GUARD_BLOCK=1 npm run build
```

Tests run against a stub SignalR server (`test/stub-copilot.ts`) that speaks the real
framing, so a full turn — including the mandatory `Metrics` frame, ping handling,
Disengaged detection and the stop-on-abort frame — is exercised offline.

Chat and tool calling (and upstream's agent provisioning, since removed) have been run
against one live tenant, through opencode 2.2.5. Image upload has not, and file edits, shell commands and multi-step tasks
have not been exercised there. Other M365 behaviour is implemented from the protocol notes in
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy) (MIT), whose
`docs/` are the source of truth for this surface. Run `opencode-m365 doctor --live`
against your own tenant before trusting it.

## Credit

The protocol this implements was reverse-engineered by
[cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy). This is an
independent implementation written against that project's documentation, not a fork of
its code.

## Licence

MIT — upstream's copyright notice is kept in [LICENSE](LICENSE); this fork's changes are
under the same licence. This speaks to Microsoft's API with your own credentials on your own account —
whether that is acceptable is between you and your tenant's acceptable-use policy.
