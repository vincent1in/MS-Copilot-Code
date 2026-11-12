// Make a real MSAL token cache for the check, using MSAL's own code with a fake network
// client: no request leaves this process. `valid` holds a usable access token; `expired`
// holds one that ran out, so the gateway has to refresh it at login.microsoftonline.com.
import { createRequire } from "node:module";
import { readdirSync, writeFileSync } from "node:fs";
// MSAL from the checkout's node_modules, or, in the release folder (no node_modules for
// it), the copy bundled into dist/.
async function loadMsal() {
  try {
    return createRequire(new URL("../../package.json", import.meta.url))("@azure/msal-node");
  } catch {
    const dist = new URL("../../dist/", import.meta.url);
    for (const file of readdirSync(dist).filter((f) => f.endsWith(".mjs") && f !== "cli.mjs")) {
      const mod = await import(new URL(file, dist));
      if (mod.PublicClientApplication) return mod;
    }
    throw new Error("MSAL not found in node_modules or dist/");
  }
}
const { PublicClientApplication } = await loadMsal();
const [dir, mode] = process.argv.slice(2);
const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const SCOPES = ["https://substrate.office.com/sydney/M365Chat.Read", "https://substrate.office.com/sydney/sydney.readwrite"];
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const tid = "11111111-2222-3333-4444-555555555555", oid = "66666666-7777-8888-9999-000000000000";
const jwt = (claims) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig`;
const idToken = jwt({ aud: CLIENT_ID, iss: `https://login.microsoftonline.com/${tid}/v2.0`, iat: now, nbf: now, exp: now + 3600, oid, tid, preferred_username: "alice@contoso.com", name: "Alice", sub: "s" });
const accessToken = jwt({ aud: "https://substrate.office.com/sydney", oid, tid, upn: "alice@contoso.com", exp: now + 3600 });
const ok = (body) => ({ headers: {}, body, status: 200 });
const metadata = { token_endpoint: `https://login.microsoftonline.com/common/oauth2/v2.0/token`, authorization_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", issuer: "https://login.microsoftonline.com/{tenantid}/v2.0", end_session_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/logout", jwks_uri: "https://login.microsoftonline.com/common/discovery/v2.0/keys" };
const networkClient = {
  async sendGetRequestAsync(url) {
    if (url.includes("openid-configuration")) return ok(metadata);
    if (url.includes("discovery/instance")) return ok({ tenant_discovery_endpoint: "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration", "api-version": "1.1", metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net", "login.microsoft.com", "sts.windows.net"] }] });
    throw new Error("unexpected GET " + url);
  },
  async sendPostRequestAsync() {
    return ok({ token_type: "Bearer", scope: SCOPES.join(" "), expires_in: 3600, ext_expires_in: 3600, access_token: accessToken, refresh_token: "fake-refresh-token", id_token: idToken, client_info: b64({ uid: oid, utid: tid }) });
  },
};
let serialized = "";
const app = new PublicClientApplication({
  auth: { clientId: CLIENT_ID, authority: "https://login.microsoftonline.com/common" },
  system: { networkClient },
  cache: { cachePlugin: { beforeCacheAccess: async () => {}, afterCacheAccess: async (c) => { if (c.cacheHasChanged) serialized = c.tokenCache.serialize(); } } },
});
await app.acquireTokenByCode({ code: "fake-code", scopes: SCOPES, redirectUri: "https://login.microsoftonline.com/common/oauth2/nativeclient" });
const cache = JSON.parse(serialized);
if (mode === "expired") for (const at of Object.values(cache.AccessToken)) { at.expires_on = String(now - 600); at.extended_expires_on = String(now - 600); }
writeFileSync(`${dir}/msal-cache.json`, JSON.stringify(cache), { mode: 0o600 });
console.log(mode, "cache:", Object.keys(cache).map((k) => `${k}=${Object.keys(cache[k]).length}`).join(" "));
