/**
 * Loaded by vitest before every test file (see vitest.config.ts).
 *
 * Tests must never touch the network: the suite drives a stub SignalR server on
 * loopback. This makes that a rule rather than a convention — any non-loopback
 * connection, DNS lookup or fetch from a test fails with ENETGUARD.
 */
import { createRequire } from "node:module";

process.env.NET_GUARD_BLOCK = "1";
createRequire(import.meta.url)("../scripts/net-guard.cjs");
