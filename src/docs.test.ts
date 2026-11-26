import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_TITLE_MODEL, MODEL_ALIASES, listModelIds } from "./models.js";
import { MAX_MCP_SEARCHES } from "./server.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

/** The text of one `## ` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The text of one `### ` subsection, up to the next `## ` or `### ` heading. */
function subsection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n### ${heading}\n`);
  if (start < 0) return "";
  const rest = markdown.slice(start + 1);
  const end = rest.slice(1).search(/\n##+ /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

/** The `| \`id\` |` first cells of every table row in a piece of markdown. */
function firstCellIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1] ?? "");
}

const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

/** Upstream's models that need a premium licence, the paid scenario or Copilot credits. */
const COSTLY = ["gpt-6.2-astra", "gpt-6-astra", "gpt-6-think-deeper", "claude-opus", "claude-opus-4.8", "claude-sonnet-5.5", "claude-sonnet-5", "claude-fable"];

describe("docs for installing", () => {
  const quickStart = section(readme, "Quick start");
  const installing = section(readme, "Installing and updating");

  it("gives the one-line install for macOS, Linux and Windows, from this repository's latest release", () => {
    expect(quickStart).toContain("curl -fsSL https://github.com/vincent1in/MS-Copilot-Code/releases/latest/download/install.sh | sh");
    expect(quickStart).toContain("irm https://github.com/vincent1in/MS-Copilot-Code/releases/latest/download/install.ps1 | iex");
  });

  it("says what the script downloads and checks, and that it leaves OpenCode's config alone", () => {
    expect(installing).toContain("opencode-m365-copilot.zip.sha256");
    expect(installing).toContain("SHA256SUMS");
    expect(installing).toContain("release-assets.githubusercontent.com");
    expect(installing).toMatch(/doesn't touch OpenCode's\s+config/);
  });

  it("offers reading the script first, and installing without it", () => {
    expect(installing).toContain("sh install.sh --zip opencode-m365-copilot.zip");
    expect(installing).toContain("-File install.ps1 -Zip opencode-m365-copilot.zip");
    expect(installing).toContain("start.cmd");
  });

  it("names the workflow that builds the releases", () => {
    expect(installing).toContain(".github/workflows/release.yml");
  });
});

describe("docs for the opt-in MCP tool search", () => {
  const mcp = section(readme, "MCP tools");

  it("has an MCP tools section right after How tool calling works", () => {
    expect(headings.indexOf("MCP tools")).toBe(headings.indexOf("How tool calling works") + 1);
  });

  it("says it is off by default, where to turn it on, and what Copilot then receives", () => {
    expect(mcp).toMatch(/by default Copilot is shown no MCP tools at all/);
    expect(mcp).toContain("`mcpProxy`");
    expect(mcp).toContain("M365_MCP_PROXY=1");
    expect(mcp).toMatch(/signatures and descriptions/);
    expect(mcp).toContain("substrate.office.com");
  });

  it("explains a fenced search, the cost and the cap", () => {
    expect(mcp).toMatch(/```mcp\nsearch: /);
    expect(mcp).toContain(`${MAX_MCP_SEARCHES} searches`);
    expect(mcp).toMatch(/not (yet )?(been )?measured/);
  });

  it("explains Code Mode, the call and its body, and the partial catalogue", () => {
    expect(mcp).toContain("Code Mode");
    expect(mcp).toContain("`execute`");
    expect(mcp).toMatch(/```mcp\ncall: tools\.github\.create_issue\n\{/);
    expect(mcp).toMatch(/```mcp\ncall: tools\.\w+\.\w+\n\w+: /);
    expect(mcp).toContain("return await tools.github.create_issue(");
    expect(mcp).toMatch(/partial/);
    expect(mcp).toContain("return await search(");
    expect(mcp).toContain("mcpCall");
  });

  it("lists the setting in the Settings table and the plugin options", () => {
    const settings = section(readme, "Settings");
    expect(settings).toMatch(/^\| MCP tool search .*\| off \| `mcpProxy` \| `M365_MCP_PROXY=1` \|$/m);
    expect(settings).toMatch(/"mcpProxy": false,\s*\/\//);
  });

  it("is in the summary of what goes to Copilot", () => {
    expect(section(readme, "What leaves your computer")).toContain("MCP tool search on");
  });

  it("has layout rows for src/mcp.ts and src/codemode.ts", () => {
    expect(agents).toMatch(/^\| `src\/mcp\.ts` \|.*`execute`/m);
    expect(agents).toMatch(/^\| `src\/codemode\.ts` \|.*Code Mode/m);
  });
});

describe("docs for the model catalogue", () => {
  const models = section(readme, "Models");

  it("has a model table with one row for every advertised model, and no other", () => {
    const rows = firstCellIds(subsection(readme, "Every model"));
    expect(rows).toEqual(listModelIds());
  });

  it("lists every alias in the alias table, against its canonical id, and nothing else", () => {
    const table = subsection(readme, "Aliases");
    for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
      expect(table, alias).toMatch(new RegExp(`^\\|[^\\n]*\`${alias.replace(/\./g, "\\.")}\`[^\\n]*\\| \`${canonical.replace(/\./g, "\\.")}\` \\|$`, "m"));
    }
    const named = [...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    for (const id of named) expect([...Object.keys(MODEL_ALIASES), ...listModelIds(), "m365/"], id).toContain(id);
  });

  it("says why upstream's costly models are left out, and that the paid scenario is never sent", () => {
    const left = subsection(readme, "Not in this fork");
    expect(left).toContain("OfficeWebPaidCopilot");
    expect(left).toContain("`licenseType`");
    expect(left).toMatch(/answered by the default model/);
    for (const name of ["GPT-6.2 Astra", "GPT-6 Astra", "GPT-6 (Think Deeper)", "Claude Opus 5.5 and 4.8", "Claude Sonnet 5.5", "Claude Sonnet 5", "Claude Fable 5.1"]) {
      expect(left, name).toContain(name);
    }
  });

  it("keeps the costly models out of every table", () => {
    for (const id of COSTLY) expect(firstCellIds(readme), id).not.toContain(id);
  });

  it("describes agent-less routing, with Claude on the relay framing", () => {
    const routes = subsection(readme, "Tool turns per model");
    expect(routes).toMatch(/every tool turn runs agent-less/i);
    expect(routes).toMatch(/\*\*Claude\*\* gets the relay framing/);
    expect(routes).toContain("ClaudeUnavailableForLicense");
    expect(models).not.toContain("M365_FORCE_AGENT");
  });
});

describe("docs for what it costs", () => {
  const costs = section(readme, "What it costs");

  it("is its own section, right after Models", () => {
    expect(headings.indexOf("What it costs")).toBe(headings.indexOf("Models") + 1);
  });

  it("has one row for every advertised model, all included, and none for an alias", () => {
    const rows = firstCellIds(costs);
    expect(rows).toEqual(listModelIds());
    for (const line of costs.split("\n").filter((row) => /^\| `/.test(row))) {
      if (line.startsWith(`| \`${LOCAL_TITLE_MODEL}\` |`)) expect(line).toMatch(/no M365 call/);
      else expect(line).toMatch(/^\| `[^`]+` \| included \| included \|$/);
    }
  });

  it("says what the left-out models cost, from the reference project's figures", () => {
    for (const figure of ["Copilot credits", "40 turns a day", "80 a day", "premium licence", "600 user messages", "15 minutes"]) {
      expect(costs, figure).toContain(figure);
    }
    expect(costs).toContain("m365-copilot-api.md");
    expect(costs).toMatch(/GPT-6\.1 Sol and GPT-6\.2 Sol have priority-access budgets too, but only on the paid\s+scenario/);
  });
});

describe("docs for context and budget in the UI", () => {
  const ui = section(readme, "Context and budget in the UI");

  it("is its own section, right after What it costs", () => {
    expect(headings.indexOf("Context and budget in the UI")).toBe(headings.indexOf("What it costs") + 1);
  });

  it("explains the estimated token meter", () => {
    expect(ui).toContain("x_m365_tokens_estimated");
    expect(ui).toMatch(/four characters/);
    expect(ui).toContain("include_usage");
  });

  it("shows the footer line and what the sidebar lists, and where each number comes from", () => {
    expect(ui).toContain("M365 12/600 msgs");
    expect(ui).toContain("prompt.footer.status");
    expect(ui).toContain("sidebar.content");
    expect(ui).toContain("m365-copilot.metrics");
    expect(ui).toContain("/v1/m365/metrics/");
    expect(ui).toMatch(/sends them nowhere/);
  });
});

describe("layout rows for the new files", () => {
  it("has a row for each of src/metrics.ts, src/tui.ts, src/tui-status.ts, the installers and the release workflow", () => {
    expect(agents).toMatch(/^\| `src\/metrics\.ts` \|/m);
    expect(agents).toMatch(/^\| `src\/tui\.ts` \|.*`\.\/tui`/m);
    expect(agents).toMatch(/^\| `src\/tui-status\.ts` \|/m);
    expect(agents).toMatch(/^\| `install\.sh`, `install\.ps1` \|/m);
    expect(agents).toMatch(/^\| `\.github\/workflows\/release\.yml` \|/m);
  });
});
