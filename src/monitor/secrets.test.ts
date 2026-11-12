import { describe, expect, it } from "vitest";
import { findSecrets } from "./secrets.js";

describe("findSecrets", () => {
  it.each([
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA"],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["signed token (JWT)", "token: eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl"],
    ["AWS access key", "key AKIAIOSFODNN7EXAMPLE here"],
    ["GitHub token", `ghp_${"a".repeat(36)}`],
    ["GitHub token", `github_pat_${"B".repeat(30)}`],
    ["Slack token", "xoxb-1234567890-abcdefghij"],
    ["Azure storage key", `DefaultEndpointsProtocol=https;AccountName=x;AccountKey=${"A".repeat(86)}==`],
    ["bearer token", `curl -H "Authorization: Bearer ${"x".repeat(30)}"`],
    ["database URL with a password", "DATABASE_URL=postgres://app:hunter2hunter2@db.internal:5432/app"],
    ["secret in an env file", "export STRIPE_SECRET_KEY=sk_live_abcdefgh123"],
  ])("finds a %s", (kind, text) => {
    expect(findSecrets(text).map((finding) => finding.kind)).toContain(kind);
  });

  it("leaves ordinary code alone", () => {
    const code = [
      "const token = await getToken();",
      "const password = form.get('password');",
      "export function secret() { return process.env.SECRET; }",
      "if (apiKey === undefined) throw new Error('missing');",
      "Bearer tokens are described in RFC 6750.",
    ].join("\n");
    expect(findSecrets(code)).toEqual([]);
  });

  it("reports line numbers, in text order", () => {
    const text = ["line one", "AKIAIOSFODNN7EXAMPLE", "", "x", "ghp_" + "z".repeat(36)].join("\n");
    expect(findSecrets(text).map((finding) => [finding.kind, finding.line])).toEqual([
      ["AWS access key", 2],
      ["GitHub token", 5],
    ]);
  });

  it("points at the secret itself, not the indentation before it", () => {
    const text = "env:\n    API_TOKEN=abcdefghijklmnop";
    const [finding] = findSecrets(text);
    expect(text.slice(finding!.index, finding!.index + finding!.length)).toBe("API_TOKEN=abcdefghijklmnop");
  });

  it("masks what it reports: enough to find it, not enough to use it", () => {
    const value = `ghp_${"q".repeat(36)}`;
    const [finding] = findSecrets(value);
    expect(finding!.preview.length).toBeLessThan(10);
    expect(value).not.toContain(finding!.preview.replace("…", "x"));
    expect(findSecrets("  DB_PASSWORD=correct-horse-battery")[0]!.preview).toBe("DB_PASSWORD=…");
    expect(findSecrets("-----BEGIN EC PRIVATE KEY-----")[0]!.preview).toBe("-----BEGIN EC PRIVATE KEY-----");
  });

  it("stops at fifty findings", () => {
    const text = Array.from({ length: 80 }, () => "AKIAIOSFODNN7EXAMPLE").join("\n");
    expect(findSecrets(text)).toHaveLength(50);
  });

  it("stays fast on a megabyte of adversarial input", () => {
    const inputs = [
      "a".repeat(1_000_000),
      "eyJ".repeat(330_000),
      `${"A".repeat(200)}=`.repeat(5_000),
      "postgres://".repeat(90_000),
      "Bearer ".repeat(140_000),
      `${"SECRET_".repeat(20)}\n`.repeat(7_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      findSecrets(input);
      expect(performance.now() - started).toBeLessThan(1_500);
    }
  });
});
