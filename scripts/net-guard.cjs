'use strict';
/**
 * net-guard: record (and optionally block) every outbound network attempt a Node
 * process makes. Load it with NODE_OPTIONS="--require /path/to/net-guard.cjs" so it
 * is preloaded into every Node process and child process a command starts.
 *
 *   NET_GUARD_LOG=/path/file.jsonl   append one JSON line per attempt
 *   NET_GUARD_BLOCK=1                throw on any non-loopback destination
 *
 * It hooks the layer every client ends up in: net.Socket.prototype.connect (plain
 * sockets, tls, http/https agents, undici/fetch, ws), plus dns.lookup, the c-ares
 * resolver functions, and fetch (for readable URLs). Only host:port and URL
 * origin+path are logged, never query strings, so tokens carried in URLs do not reach
 * the log.
 *
 * Limits: it only sees JavaScript running in Node. Native code a command executes
 * (TypeScript 7's tsc binary, the bundler's native core) and anything that is not Node
 * are invisible to it; CI therefore also runs inside a network namespace with no route
 * out (see .github/workflows/ci.yml).
 */
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const { threadId } = require('node:worker_threads');

const LOG = process.env.NET_GUARD_LOG;
const BLOCK = process.env.NET_GUARD_BLOCK === '1';

function record(entry) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, thread: threadId, argv1: process.argv[1] ?? '', ...entry })}\n`);
  } catch {
    /* never break the host process over logging */
  }
}

function isLoopback(host) {
  if (host === undefined || host === null || host === '') return true; // Node defaults to localhost
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase();
  // A strict IPv4 check: a prefix test would let "127.attacker.example" through.
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function guard(kind, host, port, extra = {}) {
  const local = isLoopback(host);
  record({ kind, host: String(host ?? 'localhost'), port: port ?? null, local, ...extra });
  if (BLOCK && !local) {
    const error = new Error(`net-guard: blocked ${kind} to ${host}:${port ?? '-'}`);
    error.code = 'ENETGUARD';
    throw error;
  }
}

record({ kind: 'loaded', host: '-', port: null, local: true });

// 1. Every TCP/TLS connection goes through Socket.prototype.connect.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  let options = args[0];
  if (Array.isArray(options)) options = options[0]; // Node's internal normalized args
  let host;
  let port;
  let path;
  if (options && typeof options === 'object') {
    host = options.host;
    port = options.port;
    path = options.path;
  } else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) {
    port = Number(options);
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof options === 'string') {
    path = options; // unix socket / named pipe
  }
  if (path === undefined) guard('socket', host, port);
  return originalConnect.apply(this, args);
};

// 2. DNS lookups (agent.ts probes a host with dns/promises.lookup).
const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, ...rest) {
  try {
    guard('dns', hostname, null);
  } catch (error) {
    const callback = rest[rest.length - 1];
    if (typeof callback === 'function') {
      process.nextTick(callback, error);
      return {};
    }
    throw error;
  }
  return originalLookup.call(this, hostname, ...rest);
};
const originalPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function lookup(hostname, ...rest) {
  guard('dns', hostname, null);
  return originalPromiseLookup.call(this, hostname, ...rest);
};

// 2b. The c-ares resolver functions (dns.resolve*, dns.reverse, dns.Resolver and their
// promise forms) send DNS queries without going through dns.lookup.
function wrapResolver(target, label) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (!/^(resolve|reverse)/.test(name) || typeof target[name] !== 'function') continue;
    const original = target[name];
    target[name] = function guardedResolver(hostname, ...rest) {
      try {
        guard('dns', hostname, null, { via: `${label}.${name}` });
      } catch (error) {
        const callback = rest[rest.length - 1];
        if (typeof callback === 'function') {
          process.nextTick(callback, error);
          return undefined;
        }
        if (label.includes('promises')) return Promise.reject(error);
        throw error;
      }
      return original.call(this, hostname, ...rest);
    };
  }
}
wrapResolver(dns, 'dns');
wrapResolver(dns.Resolver.prototype, 'dns.Resolver');
wrapResolver(dns.promises, 'dns.promises');
wrapResolver(dns.promises.Resolver.prototype, 'dns.promises.Resolver');

// 3. fetch: log the URL (origin + path only) before undici opens its socket.
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function fetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    } catch {
      return originalFetch.call(this, input, init);
    }
    try {
      guard('fetch', url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80), {
        url: `${url.protocol}//${url.host}${url.pathname}`,
        method: (init && init.method) || 'GET',
      });
    } catch (error) {
      return Promise.reject(error);
    }
    return originalFetch.call(this, input, init);
  };
}

// ESM `import { lookup } from "node:dns/promises"` reads a snapshot; refresh it.
require('node:module').syncBuiltinESMExports();
