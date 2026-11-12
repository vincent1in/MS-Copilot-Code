# opencode-m365-copilot (safety-reviewed fork)

Use your work account's **Microsoft 365 Copilot Chat** as the AI model in
[OpenCode](https://opencode.ai). This is Microsoft Copilot, not GitHub Copilot. A personal
Microsoft account's Copilot won't work: it is a different service. You don't need Copilot
Studio.

> **This is a reviewed fork** of [chrischall/opencode-copilot-plugin](https://github.com/chrischall/opencode-copilot-plugin)
> (MIT), taken at upstream `v2.2.1` (`2c03d2f`). See **[SECURITY_REVIEW.md](SECURITY_REVIEW.md)** for what
> was checked, how, and every change. In short, compared with upstream:
>
> - **Two addresses and nothing else.** It connects to `login.microsoftonline.com` to sign in and
>   `substrate.office.com` for Copilot, enforced in code. CI fails on any other connection attempt.
> - **No analytics, update checks or downloads.** The sign-in library's reports about itself are
>   stripped, and the sign-in window's own background services are switched off.
> - **Nothing is created in your tenant.** Upstream's Copilot Studio agent is removed.
> - **Interactive sign-in only**: no stored password or TOTP seed.
> - **Your work data stays out.** Bing web search is off, the mailbox-grounded models are removed,
>   and a reply Copilot drew from your email, files or chats is held back by default.
> - **A page on your computer** walks you through setup and shows exactly what each turn sends.
> - **Nothing is installed from npm.** OpenCode loads the gateway from its folder, never from the registry.

## Quick start

You need:

- the OpenCode you already have (version 2), installed from npm;
- Node.js 22 or later;
- Microsoft Edge or Google Chrome, for the sign-in window;
- a work or school account with Microsoft 365 Copilot Chat.

1. **Download** `opencode-m365-copilot-2.3.0.zip` and `opencode-m365-copilot-2.3.0.zip.sha256`.
   Check the zip: `shasum -a 256 -c opencode-m365-copilot-2.3.0.zip.sha256` on macOS and Linux,
   or `Get-FileHash opencode-m365-copilot-2.3.0.zip` in PowerShell on Windows, compared with the
   `.sha256` file. Unzip it somewhere it can stay: OpenCode loads the gateway from this folder.
2. **Start the page.** In that folder, run `sh start.sh` (macOS, Linux) or double-click
   `start.cmd` (Windows). The gateway's page opens in your browser.
3. **Follow Set up** on the page:
   1. *Sign in to Microsoft 365.* A browser window opens on Microsoft's sign-in page.
   2. *Send a test message.* You see the exact text that went to Copilot, and its reply.
   3. *Connect OpenCode.* Add the folder to `plugins` in OpenCode's config file. The page
      shows the file, the lines to add and copy buttons. It never edits the file itself.
4. **Start OpenCode** in your project with `opencode`. The gateway's models are listed as
   `m365/…`, and `m365/gpt-6.1-sol` is used when you don't pick one.

The zip holds everything that runs: the built gateway (`dist/`), Playwright for the sign-in
window, the source it was built from, and `SHA256SUMS` for every file. Nothing is installed
or downloaded, and you don't need npm. Once you're set up you can close the page: OpenCode
runs its own copy of the gateway. To watch OpenCode's turns as well, choose what happens
*When OpenCode starts* under Settings.

Rather use a terminal? `node dist/cli.mjs login` signs in, and `node dist/cli.mjs setup --quiet`
adds the folder to OpenCode's config for you, keeping a backup of the old file.

## What leaves your computer

**The gateway** connects to two addresses, both Microsoft's: `login.microsoftonline.com` to
sign in and refresh the token, and `substrate.office.com` for Copilot. Every other address is
refused in code (`src/egress.ts`), and CI runs the build and every test with no route off
the machine. It sends no analytics, checks for no updates and downloads nothing. Microsoft's
sign-in library (MSAL) adds its own name, version, operating system and CPU to each sign-in
and token request; the gateway takes those off, because signing in doesn't need them.

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

**The page** is served on 127.0.0.1 only, and Traffic and Checks stay in memory. The only
file it writes is your settings, `~/.config/opencode-copilot/settings.json`.

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
  commands"). On opencode 2.2.5 this takes the system prompt from about 8,000
  characters to about 2,000.
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
  `filePath:` for `path`, quoted values, a copied `$ ` prompt, prose or an invented
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
stub rather than Microsoft: the plugin loads from a directory, registers all 21 models,
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
| `m365_not_served` | M365 answered with its own refusal: no credits, a model this licence does not cover, or a dead tone. Called `m365_unavailable` up to 2.2.0 |
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
message. Those need the same key, take JSON only, and the page never edits OpenCode's
config.

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
the default** (upstream's was `m365/quick`): tool turns run agent-less here, where the
reference project measured GPT-6.1 Sol and GPT-6 Sol under the
`relay` framing at 39/40 and 60/60 on its bench, and 30/30 driving a real agent, on accounts
with no paid Copilot seat. Both serve on every work account with Copilot Chat. They are
reasoning tones, so expect 10–30 s a turn. These figures are the reference project's, not
yet re-measured through this fork.
The upstream measurements below are kept as they were.

Tool-calling on a live tenant (2026-11-09, one non-Premium account, a single file-read
task per run; small samples):

| Model | Made the tool call |
|---|---|
| `m365/quick` | 5/5 |
| `m365/m365-copilot` | 1/1 |
| `m365/gpt-5.5` (same tone as `quick`) | 0/1 |
| `m365/gpt-5.6` | 0/1 (the reference project: 7/30), so its picker name says "unreliable tool calls" |
| `m365/gpt-5.5-think-deeper` | 0/3 — said it had no file tool; 4/4 with the relay framing, below |

The reference project's README reports 100% tool compliance for `gpt-5.5-think-deeper`;
its protocol notes (`m365-copilot-api.md`, quirk #13) say reasoning tones disengage with
an agent attached. Our runs agree with the notes. Reasoning tones still serve plain chat.

The reasoning tones now get a different framing on tool turns. The tool block is
worded as the user asking to be guided through their own terminal, one command at a
time, pasting back the real output (the reference project's `relay`). A model that
doubts it can reach the workspace has nothing to doubt, because the user runs the
commands. Measured on `gpt-5.5-think-deeper` on 2026-11-10, 16 conversations:

| Framing | First reply said the tools were unavailable | Solved |
|---|---|---|
| Default, before the give-up nudge | 4/4 | 1/4 |
| Default, with the nudge | 8/8 | 5/8 |
| Relay, with the nudge | 0/4 | 4/4, with no nudge needed |

Claude tones run agent-less with the default framing. On an account with no Claude licence,
M365 refuses their tool turns (`ClaudeUnavailableForLicense`); upstream hid that by attaching
its Studio agent, which M365 answers on GPT. With no agent ever attached here, the tone you
pick is the model that answers.

### No mailbox-grounded models in this fork

Upstream's `m365/work` and `m365/work-think` (Copilot searching your mail, Teams and files
server-side through the Outlook side-pane scenario, which also sent an
`EnableStarterLicenseCheckBypass` feature flag) are removed. Every model here is a coding
model and never grounds on your account's content.

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

- **600 user messages per conversation.** The proxy reuses one conversation per task,
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
- `usage` reports zero tokens. M365 never exposes token counts; the `x_m365_*` extension
  fields carry what it does report, including `x_m365_dea_score`, the classifier score
  that rises before the Disengaged filter fires.

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
