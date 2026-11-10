import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { describe, expect, it } from "vitest";

/**
 * Proves the suite-wide network guard (test/net-guard.setup.ts) is really on, so a
 * test that starts reaching the network fails instead of passing quietly.
 *
 * The probes use the reserved `.invalid` TLD (RFC 2606), which can never resolve: CI's
 * connection report recognises these as the guard's own self-test and fails on anything
 * else.
 */
describe("net-guard", () => {
  it("blocks fetch to a remote host", async () => {
    await expect(fetch("https://net-guard-selftest.invalid/")).rejects.toMatchObject({ code: "ENETGUARD" });
  });

  it("blocks DNS lookups of remote hosts", async () => {
    await expect(lookup("net-guard-selftest.invalid")).rejects.toMatchObject({ code: "ENETGUARD" });
  });

  it("still allows loopback", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("ok");
    } finally {
      server.close();
    }
  });
});
