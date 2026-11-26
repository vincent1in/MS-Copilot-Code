import { describe, expect, it } from "vitest";
import { buildModelInfos } from "./config.js";
import {
  DEFAULT_MODEL,
  LOCAL_TITLE_MODEL,
  MODEL_ALIASES,
  MODELS,
  isLocalModel,
  listModelIds,
  resolveModel,
  toneFor,
  toolRouteFor,
} from "./models.js";

describe("model catalog", () => {
  it("maps every M365-backed model id to a non-empty tone", () => {
    // Locally-served models (the titler) deliberately carry no tone — that null is
    // exactly what marks them as "never open a conversation".
    for (const model of MODELS.filter((candidate) => !isLocalModel(candidate.id))) {
      expect(model.tone, `${model.id} has no tone`).toBeTruthy();
    }
  });

  it("has no mailbox-grounded models (removed in this fork)", () => {
    const ids = MODELS.map((model) => model.id);
    expect(ids).not.toContain("work");
    expect(ids).not.toContain("work-think");
    // An old config naming one falls back to the default coding model.
    expect(resolveModel("m365/work").id).toBe(DEFAULT_MODEL);
  });

  it("has unique ids", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The tone is what actually selects the model server-side — there is no `model`
  // parameter in the M365 protocol (docs/m365-copilot-api.md §5).
  it("resolves the documented tones", () => {
    expect(toneFor("gpt-5.5-think-deeper")).toBe("Gpt_5_5_Reasoning");
    expect(toneFor("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(toneFor("m365-copilot")).toBe("magic");
    expect(toneFor("quick")).toBe("Gpt_5_5_Chat");
    expect(toneFor("think-deeper")).toBe("Gpt_5_5_Reasoning");
    expect(toneFor("gpt-5.4-quick")).toBe("Gpt_5_4_Chat");
    expect(toneFor("gpt-5.3")).toBe("Gpt_5_3_Chat");
    expect(toneFor("gpt-5.2-quick")).toBe("Gpt_5_2_Chat");
    expect(toneFor("claude-sonnet")).toBe("Claude_Sonnet");
  });

  // The server fails these with `Failed to invoke 'Chat'`, and every retry is wasted.
  it("advertises no retired tone", () => {
    const retired = /_Quick$|^Gpt_Chat$|^Gpt_Reasoning$/;
    for (const model of MODELS) {
      expect(model.tone ?? "", `${model.id} selects a retired tone`).not.toMatch(retired);
    }
  });

  it("treats unknown model ids as the default rather than throwing", () => {
    // Harnesses send model ids we did not advertise; falling back beats a 400.
    expect(toneFor("something-we-never-shipped")).toBe(toneFor(DEFAULT_MODEL));
  });

  it("defaults to GPT-6.1 Sol, the best-measured tone for agent-less tool turns", () => {
    // Upstream's Studio agent is removed from this fork, so tool turns run agent-less; see
    // the comment on DEFAULT_MODEL for the measurements behind this choice.
    expect(DEFAULT_MODEL).toBe("gpt-6.1-sol");
    expect(toneFor(DEFAULT_MODEL)).toBe("Gpt_61_Sol_Reasoning");
    expect(toneFor("gpt-6-sol")).toBe("Gpt_6_Sol_Reasoning");
    // The upstream default stays selectable.
    expect(toneFor("quick")).toBe("Gpt_5_5_Chat");
  });

  it("puts the Sol tones on the relay framing with the measured sandbox note", () => {
    for (const tone of ["Gpt_61_Sol_Reasoning", "Gpt_6_Sol_Reasoning"]) {
      const route = toolRouteFor(tone);
      expect(route.framing).toBe("relay");
      expect(route.sandbox).toContain("bash_tool");
    }
    expect(toolRouteFor("Gpt_5_5_Chat")).toEqual({ framing: "default" });
  });

  it("offers the GPT-5.6 chat tone", () => {
    expect(toneFor("gpt-5.6")).toBe("Gpt_5_6_Chat");
    expect(toneFor("gpt-5.6-quick")).toBe("Gpt_5_6_Chat");
  });

  it("marks reasoning models so opencode can render them correctly", () => {
    expect(resolveModel("gpt-5.5-think-deeper").reasoning).toBe(true);
    expect(resolveModel("gpt-5.5").reasoning).toBe(false);
    expect(resolveModel("quick").reasoning).toBe(false);
  });

  it("advertises a roomy context window", () => {
    // M365 accepts >=500k tokens of retrieval-backed input (their F9). A small
    // advertised window makes harnesses pre-truncate prompts for no reason.
    for (const model of MODELS) {
      expect(model.limit.context).toBeGreaterThanOrEqual(128_000);
      expect(model.limit.output).toBeGreaterThan(0);
    }
  });

  it("exposes a local title model that never reaches M365", () => {
    expect(isLocalModel(LOCAL_TITLE_MODEL)).toBe(true);
    expect(isLocalModel(DEFAULT_MODEL)).toBe(false);
  });

  it("includes the local title model in the advertised list", () => {
    expect(listModelIds()).toContain(LOCAL_TITLE_MODEL);
    expect(listModelIds()).toContain(DEFAULT_MODEL);
  });
});

describe("model picker names", () => {
  // opencode 2's Model.Info has no description, so `name` is all the picker shows.
  const withReach = MODELS.filter((model) => model.tone !== null);

  it("marks every model that reaches M365 as a Code model", () => {
    for (const model of withReach) {
      expect(model.name, `model ${model.id} has the wrong purpose prefix`).toMatch(/^Code · /);
    }
  });

  it("warns in the name that GPT-5.6 chat is unreliable at calling tools", () => {
    // The reference project measured 7/30; ours 0/1. The name is the only place to say so.
    for (const id of ["gpt-5.6", "gpt-5.6-quick"]) expect(resolveModel(id).name).toMatch(/unreliable tool calls/);
    expect(resolveModel("gpt-5.6-quick").name).toContain("GPT-5.6 (Quick");
    expect(resolveModel("quick").name).not.toMatch(/unreliable/);
  });

  it("lists GPT-5.6 chat after the default", () => {
    const ids = MODELS.map((model) => model.id);
    expect(ids.indexOf("gpt-5.6-quick")).toBeGreaterThan(ids.indexOf("quick"));
  });

  it("does not badge the local titler, which is neither", () => {
    expect(resolveModel(LOCAL_TITLE_MODEL).name).not.toMatch(/^(Work|Code) · /);
  });
});

describe("how each tone is asked to call tools", () => {
  it("keeps the chat GPT tones on the default framing", () => {
    expect(toolRouteFor("Gpt_5_5_Chat")).toEqual({ framing: "default" });
    expect(toolRouteFor("magic")).toEqual({ framing: "default" });
  });

  it("gives the reasoning tones the relay framing", () => {
    // Agent-less GPT-5.x made no tool calls in the reference project (0/4).
    expect(toolRouteFor("Gpt_5_5_Reasoning")).toEqual({ framing: "relay" });
  });

  it("sends Claude as a relay, the route the reference project measured agent-less", () => {
    for (const tone of ["Claude_Sonnet", "Claude_Sonnet_Reasoning"]) expect(toolRouteFor(tone)).toEqual({ framing: "relay" });
  });

  it("routes GPT-6.2 Sol like the other Sol tones, steering it off its own sandbox", () => {
    expect(toolRouteFor("Gpt_62_Sol_Reasoning")).toEqual(toolRouteFor("Gpt_61_Sol_Reasoning"));
    expect(toolRouteFor("Gpt_62_Sol_Reasoning").sandbox).toContain("bash_tool");
  });
});

describe("compatibility aliases", () => {
  // Each pair once showed twice in opencode's picker under one name.
  const pairs: Array<[alias: string, canonical: string]> = [
    ["auto", "m365-copilot"],
    ["claude", "claude-sonnet"],
    ["gpt-5.4", "gpt-5.4-think-deeper"],
    ["gpt-5.3", "gpt-5.3-quick"],
    ["gpt-5.2", "gpt-5.2-quick"],
    // The chat tones, folded too: one picker entry each.
    ["gpt-5.5", "quick"],
    ["gpt-5.5-quick", "quick"],
    ["gpt-5.6", "gpt-5.6-quick"],
    // And the reasoning tone's generic id.
    ["think-deeper", "gpt-5.5-think-deeper"],
    // The included-scenario Claude Sonnet, by version.
    ["claude-sonnet-4.6", "claude-sonnet"],
    ["claude-sonnet-4.5", "claude-sonnet"],
  ];

  it("advertises one model per tone", () => {
    const tones = MODELS.filter((model) => model.tone).map((model) => model.tone);
    expect(new Set(tones).size, `shared: ${tones.filter((t, i) => tones.indexOf(t) !== i)}`).toBe(tones.length);
  });

  it("names the upstream default by its generation", () => {
    expect(resolveModel("quick").name).toContain("GPT-5.5 (Quick)");
  });

  it("advertises unique ids and no duplicate picker names", () => {
    const names = MODELS.map((model) => model.name);
    expect(new Set(names).size, `duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`).toBe(names.length);
    const ids = listModelIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps each alias to its canonical id", () => {
    expect(Object.entries(MODEL_ALIASES).sort()).toEqual([...pairs].sort());
  });

  it.each(pairs)("%s resolves to the same model as %s", (alias, canonical) => {
    expect(resolveModel(alias)).toBe(resolveModel(canonical));
    expect(resolveModel(alias).id).toBe(canonical);
  });

  it.each(pairs)("the prefixed m365/%s still resolves", (alias, canonical) => {
    expect(resolveModel(`m365/${alias}`).id).toBe(canonical);
  });

  it("keeps aliases out of every advertised list", () => {
    const aliases = Object.keys(MODEL_ALIASES);
    for (const id of [...listModelIds(), ...buildModelInfos().map((model) => model.id)]) {
      expect(aliases).not.toContain(id);
    }
  });

  it("leaves the canonical models' tone and reasoning unchanged", () => {
    expect(resolveModel("auto")).toMatchObject({ tone: "magic", reasoning: false });
    expect(resolveModel("claude")).toMatchObject({ tone: "Claude_Sonnet", reasoning: false });
    expect(resolveModel("gpt-5.4")).toMatchObject({ tone: "Gpt_5_4_Reasoning", reasoning: true });
    expect(resolveModel("gpt-5.3")).toMatchObject({ tone: "Gpt_5_3_Chat", reasoning: false });
    expect(resolveModel("gpt-5.2")).toMatchObject({ tone: "Gpt_5_2_Chat", reasoning: false });
  });

  it("keeps the catalogue order: the recommended Sol first, the local titler last", () => {
    const ids = listModelIds();
    expect(ids.slice(0, 3)).toEqual(["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-sol"]);
    expect(ids.indexOf("gpt-5.6-think-deeper")).toBeLessThan(ids.indexOf("gpt-5.5-think-deeper"));
    expect(ids.at(-1)).toBe(LOCAL_TITLE_MODEL);
  });
});

describe("GPT-6 Sol models", () => {
  // From the reference protocol notes: each serves on the included scenario on every
  // account, and agent-less has a remote bash sandbox of its own.
  const sol: Array<[id: string, tone: string]> = [
    ["gpt-6-sol", "Gpt_6_Sol_Reasoning"],
    ["gpt-6.1-sol", "Gpt_61_Sol_Reasoning"],
    ["gpt-6.2-sol", "Gpt_62_Sol_Reasoning"],
  ];

  it.each(sol)("%s selects %s, as a reasoning model", (id, tone) => {
    const model = resolveModel(id);
    expect(model.id).toBe(id);
    expect(model.tone).toBe(tone);
    expect(model.reasoning).toBe(true);
    expect(resolveModel(`m365/${id}`).id).toBe(id);
  });

  it.each(sol)("%s is framed as a relay that steers it off its own sandbox", (_id, tone) => {
    const route = toolRouteFor(tone);
    expect(route.framing).toBe("relay");
    expect(route.sandbox).toContain("bash_tool");
  });

  it("names them as in the M365 web client", () => {
    expect(resolveModel("gpt-6.2-sol").name).toBe("Code · GPT-6.2 Sol");
    expect(resolveModel("gpt-6.1-sol").name).toContain("GPT-6.1 Sol");
  });

  it("puts GPT-6.2 Sol in opencode's catalogue, with tools on", () => {
    const info = buildModelInfos().find((candidate) => candidate.id === "gpt-6.2-sol");
    expect(info).toBeDefined();
    expect(info!.capabilities.tools).toBe(true);
  });
});

describe("models that need a premium licence or spend Copilot credits", () => {
  // Upstream lists these. This fork does not, and never sends M365's paid scenario.
  const excluded = [
    "gpt-6.2-astra",
    "gpt-6-astra",
    "gpt-6-think-deeper",
    "claude-opus",
    "claude-opus-4.8",
    "claude-sonnet-5.5",
    "claude-sonnet-5",
    "claude-fable",
    "work",
    "work-think",
  ];

  it.each(excluded)("does not list %s", (id) => {
    expect(listModelIds()).not.toContain(id);
    expect(buildModelInfos().map((model) => model.id)).not.toContain(id);
    expect(Object.keys(MODEL_ALIASES)).not.toContain(id);
  });

  it.each(excluded)("answers a request for %s on the default model instead", (id) => {
    expect(resolveModel(id).id).toBe(DEFAULT_MODEL);
    expect(resolveModel(`m365/${id}`).id).toBe(DEFAULT_MODEL);
  });

  it("selects none of their tones", () => {
    const tones = new Set(MODELS.map((model) => model.tone));
    for (const tone of ["Gpt_62_Astra_Reasoning", "Gpt_6_Astra_Reasoning", "Gpt_6_Reasoning", "Claude_Opus", "Claude_Sonnet_5", "Claude_Fable"]) {
      expect(tones.has(tone), tone).toBe(false);
    }
  });

  it("marks no model as spending credits", () => {
    for (const model of MODELS) expect(model.credits, model.id).toBeFalsy();
  });

  it("does not label any model Premium or credit-billed", () => {
    for (const model of MODELS) expect(model.name, model.id).not.toMatch(/Premium|credits/);
  });
});
