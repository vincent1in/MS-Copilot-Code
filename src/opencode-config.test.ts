import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPENCODE_QUIET, connectOpenCode, openCodeStatus } from "./opencode-config.js";

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "m365-opencode-"));
  return { configPath: join(dir, "opencode", "opencode.json"), pluginDir: join(dir, "gateway") };
};

describe("OpenCode's config", () => {
  it("reports a missing config as not connected", () => {
    const { configPath, pluginDir } = fixture();
    expect(openCodeStatus(pluginDir, configPath)).toEqual({
      configPath,
      readable: false,
      connected: false,
      quiet: { update: false, share: false, websearch: false },
    });
  });

  it("sees this folder among the plugins, in either form, with its options", () => {
    const { configPath, pluginDir } = fixture();
    connectOpenCode({ pluginDir, pluginRef: join(pluginDir, "dist", "plugin.mjs"), configPath });
    expect(openCodeStatus(pluginDir, configPath).connected).toBe(true);
    writeFileSync(configPath, JSON.stringify({ plugins: [{ package: pluginDir, options: { workIq: "flag" } }] }));
    expect(openCodeStatus(pluginDir, configPath)).toMatchObject({ connected: true, pluginOptions: { workIq: "flag" } });
    expect(openCodeStatus(join(pluginDir, "elsewhere"), configPath).connected).toBe(false);
  });

  it("says why it cannot read a broken config", () => {
    const { configPath, pluginDir } = fixture();
    connectOpenCode({ pluginDir, configPath });
    writeFileSync(configPath, "{ broken");
    expect(openCodeStatus(pluginDir, configPath)).toMatchObject({ readable: false, connected: false, problem: expect.stringMatching(/not valid JSON/) });
  });

  it("adds this folder, keeps everything else, and saves the old file", () => {
    const { configPath, pluginDir } = fixture();
    connectOpenCode({ pluginDir, configPath });
    writeFileSync(configPath, JSON.stringify({ theme: "gruvbox", plugins: ["opencode-wakatime"] }));
    const result = connectOpenCode({ pluginDir, configPath });
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.theme).toBe("gruvbox");
    expect(written.plugins).toEqual(["opencode-wakatime", pluginDir]);
    expect(written).not.toHaveProperty("update");
    expect(result.backupPath).toBe(`${configPath}.bak`);
    expect(JSON.parse(readFileSync(`${configPath}.bak`, "utf8")).plugins).toEqual(["opencode-wakatime"]);
  });

  it("switches off OpenCode's own outside traffic only when asked", () => {
    const { configPath, pluginDir } = fixture();
    connectOpenCode({ pluginDir, configPath, quiet: true });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject(OPENCODE_QUIET);
    expect(OPENCODE_QUIET).toEqual({ update: "disable", share: "disabled", websearch: false });
    expect(openCodeStatus(pluginDir, configPath).quiet).toEqual({ update: true, share: true, websearch: true });
  });

  it("leaves a config it cannot read untouched", () => {
    const { configPath, pluginDir } = fixture();
    connectOpenCode({ pluginDir, configPath });
    writeFileSync(configPath, "{ broken");
    expect(() => connectOpenCode({ pluginDir, configPath })).toThrow(/not valid JSON/);
    expect(readFileSync(configPath, "utf8")).toBe("{ broken");
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });
});
