import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../tsdown.config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("packaging", () => {
  // Whatever tsdown inlines is what actually ships, and npm audit on a consumer
  // cannot see a bundled copy — a fix has to come from a release of this package.
  // Dependabot prefixes development bumps `chore`, which release-please never
  // releases, so a bundled package listed as a devDependency gets its security
  // fixes merged and never published (b14e1df did exactly that to zod).
  const bundled = ((tsdownConfig as { noExternal?: unknown[] }).noExternal ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );

  it("bundles the runtime packages it relies on", () => {
    expect(bundled).toEqual(expect.arrayContaining(["zod", "ws", "@azure/msal-node"]));
  });

  it.each(["zod", "ws", "@azure/msal-node"])("declares bundled %s as a runtime dependency, so its bumps release", (name) => {
    expect(bundled).toContain(name);
    expect(pkg.dependencies?.[name]).toBeTruthy();
    expect(pkg.devDependencies?.[name]).toBeUndefined();
  });

  it("ships exactly these runtime dependencies and nothing else", () => {
    // Every runtime dependency is reviewed code in the bundle; adding one is a review event.
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@azure/msal-node", "ws", "zod"]);
  });

  it("can never be published to npm, and pins exact versions", () => {
    expect(pkg.private).toBe(true);
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(spec, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
