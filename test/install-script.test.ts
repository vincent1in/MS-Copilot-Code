import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * install.sh, run against a small fake release: a zip holding the gateway's folder with
 * BUILD-INFO.txt, dist/cli.mjs and SHA256SUMS, and the zip's .sha256 beside it. With
 * `--zip` the script downloads nothing, so this runs with the network blocked.
 */
const script = new URL("../install.sh", import.meta.url).pathname;
const has = (tool: string) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const canRun = process.platform !== "win32" && has("zip") && has("unzip") && (has("sha256sum") || has("shasum"));

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let work: string | undefined;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});

/** Build `<work>/opencode-m365-copilot.zip` (+ `.sha256`) holding version `version`. */
function fakeRelease(version: string, tamper?: (folder: string) => void): string {
  work ??= mkdtempSync(join(tmpdir(), "install-test-"));
  const stage = join(work, `stage-${version}`);
  const folder = join(stage, `opencode-m365-copilot-${version}`);
  mkdirSync(join(folder, "dist"), { recursive: true });
  const files: Record<string, string> = {
    "BUILD-INFO.txt": `opencode-m365-copilot ${version}\ncommit: test\n`,
    "dist/cli.mjs": `console.log("gateway ${version}");\n`,
  };
  for (const [path, body] of Object.entries(files)) writeFileSync(join(folder, path), body);
  writeFileSync(
    join(folder, "SHA256SUMS"),
    Object.entries(files)
      .map(([path, body]) => `${sha256(body)}  ${path}\n`)
      .join(""),
  );
  tamper?.(folder);
  const zip = join(work, `opencode-m365-copilot-${version}.zip`);
  execFileSync("zip", ["-qr", zip, `opencode-m365-copilot-${version}`], { cwd: stage });
  writeFileSync(`${zip}.sha256`, `${sha256(readFileSync(zip))}  ${zip.split("/").pop()}\n`);
  return zip;
}

function install(zip: string, dest: string) {
  return spawnSync("sh", [script, "--zip", zip, "--dir", dest, "--no-start"], { encoding: "utf8" });
}

describe.skipIf(!canRun)("install.sh", () => {
  it("installs a checked release into the folder it is given", () => {
    const zip = fakeRelease("9.9.0");
    const dest = join(work!, "gateway");
    const run = install(zip, dest);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Nothing is downloaded");
    expect(run.stdout).toContain("version 9.9.0");
    expect(readFileSync(join(dest, "BUILD-INFO.txt"), "utf8")).toMatch(/^opencode-m365-copilot 9\.9\.0$/m);
    expect(existsSync(join(dest, "dist", "cli.mjs"))).toBe(true);
  });

  it("updates an older copy in place and leaves nothing beside it", () => {
    const older = fakeRelease("9.9.0");
    const newer = fakeRelease("9.9.1");
    const dest = join(work!, "gateway");
    expect(install(older, dest).status).toBe(0);
    const run = install(newer, dest);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("Updated the gateway");
    expect(readFileSync(join(dest, "BUILD-INFO.txt"), "utf8")).toContain("9.9.1");
    expect(existsSync(`${dest}.previous`)).toBe(false);
  });

  it("refuses a zip whose SHA-256 is not the published one, and installs nothing", () => {
    const zip = fakeRelease("9.9.0");
    appendFileSync(zip, "x");
    const dest = join(work!, "gateway");
    const run = install(zip, dest);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/not the published/);
    expect(existsSync(dest)).toBe(false);
  });

  it("refuses a zip with a file that does not match SHA256SUMS, and installs nothing", () => {
    const zip = fakeRelease("9.9.0", (folder) => appendFileSync(join(folder, "dist", "cli.mjs"), "// changed\n"));
    const dest = join(work!, "gateway");
    const run = install(zip, dest);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/dist\/cli\.mjs: FAILED/);
    expect(run.stderr).toMatch(/doesn't match its SHA256SUMS entry/);
    expect(existsSync(dest)).toBe(false);
  });

  it("will not replace a folder that is not a copy of the gateway", () => {
    const zip = fakeRelease("9.9.0");
    const dest = join(work!, "someone-elses");
    mkdirSync(dest);
    writeFileSync(join(dest, "notes.txt"), "keep me");
    const run = install(zip, dest);
    expect(run.status).not.toBe(0);
    expect(readFileSync(join(dest, "notes.txt"), "utf8")).toBe("keep me");
  });

  it("downloads only from this repository's latest release, over HTTPS", () => {
    const text = readFileSync(script, "utf8");
    const urls = [...text.matchAll(/[a-z]+:\/\/[^\s"'$)]+/g)].map((match) => match[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^https:\/\/github\.com\//);
    expect(text).toContain('REPO="vincent1in/MS-Copilot-Code"');
    expect(text).toContain('BASE="https://github.com/$REPO/releases/latest/download"');
    expect(text).toContain("--proto '=https'");
  });
});

describe("install.ps1", () => {
  const text = readFileSync(new URL("../install.ps1", import.meta.url), "utf8");

  it("downloads only from this repository's latest release", () => {
    const urls = [...text.matchAll(/[a-z]+:\/\/[^\s"'$)]+/g)].map((match) => match[0]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^https:\/\/github\.com\//);
    expect(text).toContain("$repo = 'vincent1in/MS-Copilot-Code'");
    expect(text).toContain('$base = "https://github.com/$repo/releases/latest/download"');
  });

  it("checks the zip and every file in it before installing", () => {
    expect(text).toMatch(/Get-FileHash -Algorithm SHA256 -LiteralPath \$zipFile/);
    expect(text).toMatch(/foreach \(\$line in Get-Content -LiteralPath \(Join-Path \$folder\.FullName 'SHA256SUMS'\)\)/);
  });

  it("never reuses $Zip under another case: PowerShell names are case-insensitive", () => {
    const names = new Map<string, Set<string>>();
    for (const match of text.matchAll(/\$([A-Za-z_]\w*)/g)) {
      const name = match[1]!;
      names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? new Set()).add(name));
    }
    const clashes = [...names.values()].filter((spellings) => spellings.size > 1).map((spellings) => [...spellings].join("/"));
    expect(clashes).toEqual([]);
  });

  it("is plain ASCII, which Windows PowerShell reads the same in any code page", () => {
    expect(/^[\x00-\x7f]*$/.test(text)).toBe(true);
  });
});
