import { afterEach, describe, expect, it } from "vitest";
import {
  classifyHost,
  classifyInvocation,
  describeGrounding,
  judgeGrounding,
  signalsFromAttributions,
  signalsFromControl,
  summarizeGrounding,
  workIqPolicy,
  type GroundingReport,
} from "./workiq.js";

afterEach(() => {
  delete process.env.M365_WORK_IQ;
});

describe("classifyHost", () => {
  it.each([
    "contoso.sharepoint.com",
    "contoso-my.sharepoint.com",
    "outlook.office.com",
    "outlook.office365.com",
    "teams.microsoft.com",
    "m365.cloud.microsoft",
    "loop.cloud.microsoft",
    "contoso.crm.dynamics.com",
    "graph.microsoft.com",
  ])("treats %s as work data", (host) => {
    expect(classifyHost(host)).toBe("work");
  });

  it("does not count Copilot's own service host as a source", () => {
    expect(classifyHost("substrate.office.com")).toBe("unknown");
  });

  it.each(["www.bing.com", "developer.mozilla.org", "github.com", "notsharepoint.com", "sharepoint.com.example.org"])(
    "treats %s as the web",
    (host) => {
      expect(classifyHost(host)).toBe("web");
    },
  );
});

describe("classifyInvocation", () => {
  it("trusts the call's name, not the query text inside it", () => {
    expect(classifyInvocation('search_enterprise(query="files about billing")')).toBe("work");
    expect(classifyInvocation('search_web(query="mail server config")')).toBe("web");
    expect(classifyInvocation('search(query="read file config.ts")')).toBe("unknown");
    expect(classifyInvocation(undefined)).toBe("unknown");
  });

  it("does not read 'web' into a longer word", () => {
    expect(classifyInvocation("webpack_lookup(x)")).toBe("unknown");
  });
});

describe("signalsFromControl", () => {
  it("classifies a search by its invocation", () => {
    expect(
      signalsFromControl({ messageType: "InternalSearchQuery", text: "Searching your email", invocation: 'search_enterprise(query="x")' }),
    ).toEqual([{ kind: "work", via: "search", label: "Searching your email" }]);
  });

  it("falls back to a call-shaped hiddenText, and to unknown without one", () => {
    expect(signalsFromControl({ messageType: "InternalSearchQuery", hiddenText: 'search_web(query="x")' })[0]!.kind).toBe("web");
    expect(signalsFromControl({ messageType: "InternalSearchQuery", text: "Looking up the email parser" })[0]!.kind).toBe("unknown");
  });

  it("places search results by the hosts they link to", () => {
    const signals = signalsFromControl({
      messageType: "InternalSearchResult",
      groupedSearchResults: { files: [{ url: "https://contoso.sharepoint.com/a.docx" }], web: [{ url: "https://example.org/x" }] },
    });
    expect(signals.map((signal) => [signal.kind, signal.host])).toEqual([
      ["work", "contoso.sharepoint.com"],
      ["web", "example.org"],
    ]);
  });

  it("reports a search result it cannot place, and ignores progress notes", () => {
    expect(signalsFromControl({ messageType: "InternalSearchResult", hiddenText: "{}" })[0]!.kind).toBe("unknown");
    expect(signalsFromControl({ messageType: "Progress", text: "Thinking about https://contoso.sharepoint.com" })).toEqual([]);
  });
});

describe("signalsFromAttributions", () => {
  it("names each source by title and host", () => {
    expect(
      signalsFromAttributions([
        { providerDisplayName: "Release checklist.docx", seeMoreUrl: "https://contoso.sharepoint.com/sites/eng/Release.docx" },
        { seeMoreUrl: "https://learn.microsoft.com/x" },
        { providerDisplayName: "Something" },
      ]),
    ).toEqual([
      { kind: "work", via: "source", label: "Release checklist.docx", host: "contoso.sharepoint.com" },
      { kind: "web", via: "source", label: "learn.microsoft.com", host: "learn.microsoft.com" },
      { kind: "unknown", via: "source", label: "Something" },
    ]);
  });

  it("ignores anything that is not a list", () => {
    expect(signalsFromAttributions(undefined)).toEqual([]);
    expect(signalsFromAttributions("https://contoso.sharepoint.com")).toEqual([]);
  });
});

describe("summarizeGrounding and judgeGrounding", () => {
  const report = (...kinds: ("work" | "web" | "unknown")[]): GroundingReport =>
    summarizeGrounding(kinds.map((kind, index) => ({ kind, via: "source" as const, label: `s${index}` })));

  it("takes the strongest evidence", () => {
    expect(report().verdict).toBe("none");
    expect(report("web").verdict).toBe("web");
    expect(report("web", "unknown").verdict).toBe("unknown");
    expect(report("unknown", "work", "web").verdict).toBe("work");
  });

  it("holds work data only under hold", () => {
    expect(judgeGrounding(report("work"), "hold", false)).toEqual({ verdict: "held", hold: true });
    expect(judgeGrounding(report("work"), "flag", false)).toEqual({ verdict: "flagged", hold: false });
    expect(judgeGrounding(report("work"), "allow", false)).toEqual({ verdict: "info", hold: false });
  });

  it("flags but never holds a search it cannot place", () => {
    expect(judgeGrounding(report("unknown"), "hold", false)).toEqual({ verdict: "flagged", hold: false });
  });

  it("expects the web only when Bing is on", () => {
    expect(judgeGrounding(report("web"), "hold", true)).toEqual({ verdict: "info", hold: false });
    expect(judgeGrounding(report("web"), "hold", false)).toEqual({ verdict: "flagged", hold: false });
  });

  it("has nothing to say about a turn with no grounding", () => {
    expect(judgeGrounding(report(), "hold", false)).toBeUndefined();
  });

  it("describes what was used in one sentence", () => {
    const text = describeGrounding(
      summarizeGrounding([
        { kind: "work", via: "source", label: "Release checklist.docx", host: "contoso.sharepoint.com" },
        { kind: "web", via: "source", label: "example.org", host: "example.org" },
      ]),
    );
    expect(text).toBe("Copilot drew on your work data (Release checklist.docx) and the web (example.org).");
  });
});

describe("workIqPolicy", () => {
  it("defaults to hold", () => {
    expect(workIqPolicy()).toBe("hold");
    expect(workIqPolicy({ workIq: "nonsense" })).toBe("hold");
  });

  it("takes the option first, then M365_WORK_IQ", () => {
    process.env.M365_WORK_IQ = "Allow";
    expect(workIqPolicy()).toBe("allow");
    expect(workIqPolicy({ workIq: "flag" })).toBe("flag");
    process.env.M365_WORK_IQ = "everything";
    expect(workIqPolicy()).toBe("hold");
  });
});
