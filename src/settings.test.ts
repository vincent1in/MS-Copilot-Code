import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingLockedError, SettingValueError, createSettingsStore } from "./settings.js";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "m365-settings-")), "settings.json");

describe("the settings store", () => {
  it("starts from safe defaults", () => {
    const store = createSettingsStore({ file: tempFile(), env: {} });
    expect(store.current()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toMatchObject({ workIq: "hold", webSearch: false, lean: true, leanSystemPrompt: false, pageWithOpenCode: "off" });
    expect(store.describe().workIq).toEqual({ value: "hold", source: "default" });
  });

  it("saves a change owner-only, and reads it back", () => {
    const file = tempFile();
    const store = createSettingsStore({ file, env: {} });
    store.set("workIq", "flag");
    expect(store.current().workIq).toBe("flag");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ workIq: "flag" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(createSettingsStore({ file, env: {} }).describe().workIq).toEqual({ value: "flag", source: "saved" });
  });

  it("refuses an unknown setting or a bad value, and changes nothing", () => {
    const file = tempFile();
    const store = createSettingsStore({ file, env: {} });
    expect(() => store.set("workIq", "everything")).toThrow(SettingValueError);
    expect(() => store.set("webSearch", "yes")).toThrow(SettingValueError);
    expect(() => store.set("studioAgent", true)).toThrow(SettingValueError);
    expect(() => store.set("__proto__", {})).toThrow(SettingValueError);
    expect(store.current()).toEqual(DEFAULT_SETTINGS);
  });

  it("lets the environment pin a setting, and says so", () => {
    const store = createSettingsStore({ file: tempFile(), env: { M365_WORK_IQ: "Allow", M365_WEB_SEARCH: "1", M365_MONITOR: "1" } });
    expect(store.current()).toMatchObject({ workIq: "allow", webSearch: true, pageWithOpenCode: "on" });
    expect(store.describe().workIq).toEqual({ value: "allow", source: "environment", lockedBy: "the M365_WORK_IQ environment variable" });
    expect(() => store.set("workIq", "hold")).toThrow(SettingLockedError);
  });

  it("ignores environment values it cannot read", () => {
    const store = createSettingsStore({ file: tempFile(), env: { M365_WORK_IQ: "sometimes", M365_WEB_SEARCH: "true" } });
    expect(store.current()).toMatchObject({ workIq: "hold", webSearch: false });
  });

  it("lets OpenCode's plugin options pin settings, under their old names", () => {
    const store = createSettingsStore({
      file: tempFile(),
      env: {},
      pluginOptions: { lean: false, setSmallModel: false, monitor: true, workIq: "flag", webSearch: "yes" },
    });
    const described = store.describe();
    expect(described.lean).toEqual({ value: false, source: "opencode", lockedBy: 'the "lean" option in OpenCode\'s config' });
    expect(described.localTitles.value).toBe(false);
    expect(described.pageWithOpenCode.value).toBe("on");
    expect(described.workIq.value).toBe("flag");
    // A value of the wrong type pins nothing.
    expect(described.webSearch).toEqual({ value: false, source: "default" });
  });

  it("puts the environment above OpenCode's config, and both above what was saved", () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ workIq: "allow", lean: false }));
    const store = createSettingsStore({ file, env: { M365_WORK_IQ: "hold" }, pluginOptions: { workIq: "flag", lean: true } });
    expect(store.describe().workIq.source).toBe("environment");
    expect(store.describe().lean).toMatchObject({ value: true, source: "opencode" });
  });

  it("picks up a change another gateway saved, and tells listeners", () => {
    const file = tempFile();
    const store = createSettingsStore({ file, env: {} });
    let heard = 0;
    store.onChange(() => (heard += 1));
    writeFileSync(file, JSON.stringify({ webSearch: true }));
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    expect(store.current().webSearch).toBe(true);
    expect(heard).toBe(1);
  });

  it("survives a damaged file by falling back to defaults", () => {
    const file = tempFile();
    writeFileSync(file, "{ not json");
    expect(createSettingsStore({ file, env: {} }).current()).toEqual(DEFAULT_SETTINGS);
    writeFileSync(file, JSON.stringify({ workIq: 7, lean: "no", unknown: true }));
    expect(createSettingsStore({ file, env: {} }).current()).toEqual(DEFAULT_SETTINGS);
  });
});
