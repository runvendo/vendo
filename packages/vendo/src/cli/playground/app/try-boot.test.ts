import { afterEach, describe, expect, it, vi } from "vitest";
import type { TryProfile } from "../../try/profile.js";
import {
  FALLBACK_CHIPS,
  brandTitle,
  capabilityLine,
  createTryBoot,
  depthLabel,
  liveToolMeta,
  pickStageArchetype,
  readTryConfig,
  selectSurfaceMode,
  stageGreeting,
  stageNavLabels,
  usecaseChips,
  type StageArchetype,
  type TryBootConfig,
  type TryEventSourceLike,
} from "./try-boot.js";

const config: TryBootConfig = { profileUrl: "/profile.json", eventsUrl: "/events", apiBase: "/api/vendo" };

function profileFixture(overrides: Partial<TryProfile> = {}): TryProfile {
  return {
    venue: "local",
    brand: { name: "Acme", domain: null, logoUrl: null },
    theme: null,
    brief: null,
    tools: { list: [], counts: { total: 0, enabled: 0 } },
    catalog: [],
    usecases: [],
    fixturesAvailable: false,
    depth: { level: "shallow", stages: {} },
    capabilities: { liveChat: false },
    ...overrides,
  };
}

/** DI'd EventSource: records listeners, lets tests push wire events. */
class FakeEventSource implements TryEventSourceLike {
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(data === undefined ? {} : { data });
  }
  close(): void {
    this.closed = true;
  }
}

/** A boot wired to a scripted fetch: each call consumes the next body (the
 *  last one repeats); an Error body rejects like a network failure. */
function harness(bodies: unknown[], options: { maxEventSourceErrors?: number } = {}) {
  const queue = [...bodies];
  const calls: string[] = [];
  const sources: FakeEventSource[] = [];
  const boot = createTryBoot({
    config,
    fetchImpl: async (url) => {
      calls.push(url);
      const body = queue.length > 1 ? queue.shift() : queue[0];
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body };
    },
    eventSourceFactory: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    ...options,
  });
  return { boot, calls, sources };
}

function stageEvent(stage: string, status: string): string {
  return JSON.stringify({ type: "stage", stage, status });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readTryConfig", () => {
  it("returns the boot object the server injects", () => {
    const win = { __VENDO_TRY__: { profileUrl: "/profile.json", eventsUrl: "/events", apiBase: "/api/vendo" } };
    expect(readTryConfig(win)).toEqual(config);
  });

  it("hosted venues point the same keys elsewhere — any non-empty strings pass", () => {
    const win = {
      __VENDO_TRY__: {
        profileUrl: "https://console.vendo.run/try/abc/profile.json",
        eventsUrl: "https://console.vendo.run/try/abc/events",
        apiBase: "https://console.vendo.run/try/abc/api/vendo",
      },
    };
    expect(readTryConfig(win)?.profileUrl).toBe("https://console.vendo.run/try/abc/profile.json");
  });

  it("null (classic playground mode) when the object is absent or malformed", () => {
    expect(readTryConfig({})).toBeNull();
    expect(readTryConfig(null)).toBeNull();
    expect(readTryConfig(undefined)).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: "nope" })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: null })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: { profileUrl: "/p" } })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: { profileUrl: "/p", eventsUrl: "/e", apiBase: 7 } })).toBeNull();
    expect(readTryConfig({ __VENDO_TRY__: { profileUrl: "", eventsUrl: "/e", apiBase: "/a" } })).toBeNull();
  });
});

describe("createTryBoot config", () => {
  it("exposes the boot config it was created with (Tasks 10/11 read apiBase here)", () => {
    const { boot } = harness([profileFixture()]);
    expect(boot.config).toEqual(config);
    expect(boot.config.apiBase).toBe("/api/vendo");
  });
});

describe("createTryBoot load", () => {
  it("starts loading, fetches the profile once, lands ready, opens the event stream", async () => {
    const { boot, calls, sources } = harness([profileFixture()]);
    expect(boot.state.phase).toBe("loading");
    expect(boot.state.profile).toBeNull();

    const result = await boot.load();

    expect(result.ok).toBe(true);
    expect(boot.state.phase).toBe("ready");
    expect(boot.state.profile?.brand.name).toBe("Acme");
    expect(calls).toEqual(["/profile.json"]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.url).toBe("/events");
  });

  it("is tolerant: unknown profile fields pass through untouched", async () => {
    const { boot } = harness([{ ...profileFixture(), futureField: { keep: true } }]);
    await boot.load();
    expect((boot.state.profile as Record<string, unknown>)["futureField"]).toEqual({ keep: true });
  });

  it("hard parse failure → { ok: false } + fallback phase, and no event stream", async () => {
    const { boot, sources } = harness(["not a profile object"]);
    const result = await boot.load();
    expect(result.ok).toBe(false);
    expect(boot.state.phase).toBe("fallback");
    expect(boot.state.profile).toBeNull();
    expect(sources).toHaveLength(0);
  });

  it("a network failure falls back the same way", async () => {
    const { boot } = harness([new Error("connection refused")]);
    expect((await boot.load()).ok).toBe(false);
    expect(boot.state.phase).toBe("fallback");
  });

  it("a non-2xx response falls back the same way", async () => {
    const sources: FakeEventSource[] = [];
    const boot = createTryBoot({
      config,
      fetchImpl: async () => ({ ok: false, json: async () => profileFixture() }),
      eventSourceFactory: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source;
      },
    });
    expect((await boot.load()).ok).toBe(false);
    expect(sources).toHaveLength(0);
  });
});

describe("createTryBoot deepening stream", () => {
  it("a stage event updates stages immediately and re-fetches the profile after the debounce", async () => {
    vi.useFakeTimers();
    const deepened = profileFixture({ depth: { level: "deep", stages: { brief: "done" } } });
    const { boot, calls, sources } = harness([profileFixture(), deepened]);
    await boot.load();
    let notified = 0;
    boot.subscribe(() => {
      notified += 1;
    });

    sources[0]!.emit("message", stageEvent("brief", "started"));
    expect(boot.state.stages).toEqual({ brief: "started" });
    expect(notified).toBeGreaterThan(0);
    // Burst of events: ONE debounced refetch, keyed off the last event.
    sources[0]!.emit("message", stageEvent("brief", "done"));
    sources[0]!.emit("message", stageEvent("usecases", "done"));
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300);

    expect(calls).toHaveLength(2);
    expect(boot.state.profile?.depth.level).toBe("deep");
    expect(boot.state.stages).toEqual({ brief: "done", usecases: "done" });
  });

  it("junk wire data never crashes the store", async () => {
    vi.useFakeTimers();
    const { boot, calls, sources } = harness([profileFixture()]);
    await boot.load();
    sources[0]!.emit("message", "not json");
    sources[0]!.emit("message", JSON.stringify({ type: "other" }));
    sources[0]!.emit("message", JSON.stringify({ type: "stage", stage: 7, status: "done" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(boot.state.stages).toEqual({});
    expect(boot.state.phase).toBe("ready");
  });

  it("a failed refetch keeps the profile it had — the surface never blanks", async () => {
    vi.useFakeTimers();
    const { boot, calls, sources } = harness([profileFixture(), new Error("server restarting")]);
    await boot.load();
    sources[0]!.emit("message", stageEvent("brief", "done"));
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(2);
    expect(boot.state.phase).toBe("ready");
    expect(boot.state.profile?.brand.name).toBe("Acme");
  });

  it("close() tears down: EventSource closed, pending refetch cancelled, listeners dropped", async () => {
    vi.useFakeTimers();
    const { boot, calls, sources } = harness([profileFixture()]);
    await boot.load();
    let notified = 0;
    boot.subscribe(() => {
      notified += 1;
    });
    sources[0]!.emit("message", stageEvent("brief", "done"));
    const notifiedBeforeClose = notified;

    boot.close();

    expect(sources[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    expect(notified).toBe(notifiedBeforeClose);
  });

  it("hard errors: after N consecutive failures the stream just stops — state stays intact", async () => {
    const { boot, sources } = harness([profileFixture()], { maxEventSourceErrors: 2 });
    await boot.load();
    sources[0]!.emit("error");
    expect(sources[0]!.closed).toBe(false);
    sources[0]!.emit("error");
    expect(sources[0]!.closed).toBe(true);
    expect(boot.state.phase).toBe("ready");
    expect(boot.state.profile?.brand.name).toBe("Acme");
  });

  it("a live message resets the error count (native retry recovered)", async () => {
    const { boot, sources } = harness([profileFixture()], { maxEventSourceErrors: 2 });
    await boot.load();
    sources[0]!.emit("error");
    sources[0]!.emit("open");
    sources[0]!.emit("error");
    expect(sources[0]!.closed).toBe(false);
  });

  it("a throwing listener neither aborts the notify loop nor escapes into the SSE callback", async () => {
    const { boot, sources } = harness([profileFixture()]);
    boot.subscribe(() => {
      throw new Error("bad listener");
    });
    let notified = 0;
    boot.subscribe(() => {
      notified += 1;
    });

    // Notify path 1: load's setState — the returned promise must not reject.
    await expect(boot.load()).resolves.toEqual({ ok: true });
    expect(notified).toBeGreaterThan(0);

    // Notify path 2: a stage event — the throw must not escape emit (in the
    // browser that frame IS the EventSource message callback).
    const before = notified;
    expect(() => sources[0]!.emit("message", stageEvent("brief", "started"))).not.toThrow();
    expect(notified).toBeGreaterThan(before);
    expect(boot.state.stages).toEqual({ brief: "started" });
  });
});

describe("depthLabel", () => {
  it("learning while any live stage is pending/started", () => {
    expect(depthLabel(profileFixture(), { brief: "started" })).toBe("Learning your codebase…");
    expect(depthLabel(profileFixture(), { usecases: "pending" })).toBe("Learning your codebase…");
    expect(depthLabel(null, { brief: "started" })).toBe("Learning your codebase…");
  });

  it("learning wins over deep while a re-run is in flight", () => {
    const deep = profileFixture({ depth: { level: "deep", stages: {} } });
    expect(depthLabel(deep, { fixtures: "started" })).toBe("Learning your codebase…");
  });

  it("profiled once the profile reports deep", () => {
    const deep = profileFixture({ depth: { level: "deep", stages: { brief: "done" } } });
    expect(depthLabel(deep)).toBe("Profiled from your codebase");
    expect(depthLabel(deep, { brief: "done", usecases: "skipped" })).toBe("Profiled from your codebase");
  });

  it("null when shallow with no AI in flight (disk-default pending stages don't count)", () => {
    expect(depthLabel(profileFixture())).toBeNull();
    expect(depthLabel(profileFixture(), {})).toBeNull();
    expect(depthLabel(profileFixture(), { brief: "failed", usecases: "skipped" })).toBeNull();
    expect(depthLabel(null)).toBeNull();
  });
});

describe("brandTitle", () => {
  it("uses the profile's brand name", () => {
    expect(brandTitle(profileFixture())).toBe("Acme");
  });

  it("falls back to the neutral label when unset", () => {
    expect(brandTitle(profileFixture({ brand: { name: null, domain: null, logoUrl: null } }))).toBe("Your product");
    expect(brandTitle(profileFixture({ brand: { name: "  ", domain: null, logoUrl: null } }))).toBe("Your product");
    expect(brandTitle(null)).toBe("Your product");
  });
});

describe("usecaseChips", () => {
  const seeded = [
    { label: "Build a renewals dashboard", prompt: "Build me a dashboard of my upcoming renewals" },
    { label: "Flag at-risk accounts", prompt: "Which of my accounts look at risk this quarter?" },
  ];

  it("generic fallbacks before the seeds artifact lands (no profile, or empty usecases)", () => {
    expect(usecaseChips(null)).toEqual(FALLBACK_CHIPS);
    expect(usecaseChips(profileFixture())).toEqual(FALLBACK_CHIPS);
  });

  it("the profile's seeded chips once they exist — same call, so a store update swaps live", () => {
    expect(usecaseChips(profileFixture({ usecases: seeded }))).toEqual(seeded);
  });

  it("junk entries are dropped, not rendered as dead pills (tolerant profile parse lets anything in)", () => {
    const junk = [
      { label: "", prompt: "blank label" },
      { label: "blank prompt", prompt: "   " },
      { label: 7, prompt: "non-string label" },
      "not even an object",
      seeded[0],
    ] as unknown as TryProfile["usecases"];
    expect(usecaseChips(profileFixture({ usecases: junk }))).toEqual([seeded[0]]);
  });

  it("all-junk or non-array usecases fall back to the generic set", () => {
    const blank = [{ label: " ", prompt: "" }] as TryProfile["usecases"];
    expect(usecaseChips(profileFixture({ usecases: blank }))).toEqual(FALLBACK_CHIPS);
    const notArray = profileFixture();
    (notArray as Record<string, unknown>)["usecases"] = { nope: true };
    expect(usecaseChips(notArray)).toEqual(FALLBACK_CHIPS);
  });

  it("ships exactly three generic fallbacks, each pressable (label + prompt)", () => {
    expect(FALLBACK_CHIPS).toHaveLength(3);
    for (const chip of FALLBACK_CHIPS) {
      expect(chip.label.trim()).not.toBe("");
      expect(chip.prompt.trim()).not.toBe("");
    }
  });
});

/** A profile whose tools carry the given names + descriptions (the archetype
 *  picker's scan surface — descriptions hold the bound route paths). */
function profileWithTools(entries: Array<[string, string]>, overrides: Partial<TryProfile> = {}): TryProfile {
  return profileFixture({
    tools: {
      list: entries.map(([name, description]) => ({ name, description, risk: "read", disabled: false })),
      counts: { total: entries.length, enabled: entries.length },
    },
    ...overrides,
  });
}

describe("pickStageArchetype", () => {
  it("finance on invoices/payments/accounts tool domains (demo-bank shape)", () => {
    const profile = profileWithTools([
      ["host_listAccounts", "GET /api/accounts"],
      ["host_listScheduledPayments", "GET /api/payments/scheduled"],
      ["host_transferMoney", "POST /api/transfers"],
      ["host_getSpendingInsights", "GET /api/insights/spending"],
    ]);
    expect(pickStageArchetype(profile)).toBe("finance");
  });

  it("commerce on orders/products/cart keywords", () => {
    const profile = profileWithTools([
      ["host_listProducts", "GET /api/products"],
      ["host_createOrder", "POST /api/orders"],
      ["host_getCart", "GET /api/cart"],
    ]);
    expect(pickStageArchetype(profile)).toBe("commerce");
  });

  it("content on posts/comments/feed keywords — the HTTP verb POST never counts", () => {
    const profile = profileWithTools([
      ["host_listPosts", "GET /api/posts"],
      ["host_createComment", "POST /api/posts/{id}/comments"],
      ["host_getFeed", "GET /api/feed"],
    ]);
    expect(pickStageArchetype(profile)).toBe("content");
    // Write tools alone ("POST /api/…" descriptions) are not content signal.
    const writes = profileWithTools([
      ["host_updateWidget", "POST /api/widgets/{id}"],
      ["host_removeWidget", "DELETE /api/widgets/{id}"],
    ]);
    expect(pickStageArchetype(writes)).toBe("dashboard");
  });

  it("docs on docs/pages/blocks keywords", () => {
    const profile = profileWithTools([
      ["host_listPages", "GET /api/pages"],
      ["host_getBlock", "GET /api/pages/{id}/blocks/{blockId}"],
      ["host_searchDocs", "GET /api/docs/search"],
    ]);
    expect(pickStageArchetype(profile)).toBe("docs");
  });

  it("dashboard on issues/projects keywords AND as the no-match fallback", () => {
    const issues = profileWithTools([
      ["host_listIssues", "GET /api/issues"],
      ["host_listProjects", "GET /api/projects"],
    ]);
    expect(pickStageArchetype(issues)).toBe("dashboard");
    expect(pickStageArchetype(profileWithTools([["host_ping", "GET /api/ping"]]))).toBe("dashboard");
    expect(pickStageArchetype(profileFixture())).toBe("dashboard");
    expect(pickStageArchetype(null)).toBe("dashboard");
  });

  it("the strongest keyword family wins a mixed toolset", () => {
    const profile = profileWithTools([
      ["host_listProjects", "GET /api/projects"],
      ["host_listInvoices", "GET /api/invoices"],
      ["host_payInvoice", "POST /api/invoices/{id}/payments"],
      ["host_listTransactions", "GET /api/transactions"],
    ]);
    expect(pickStageArchetype(profile)).toBe("finance");
  });

  it("brand.industry (a passthrough field, read defensively) overrides keywords", () => {
    const profile = profileWithTools([["host_listIssues", "GET /api/issues"]]);
    (profile.brand as Record<string, unknown>)["industry"] = "Retail & e-commerce";
    expect(pickStageArchetype(profile)).toBe("commerce");
  });

  it("junk industry values fall through to the keyword scan", () => {
    const profile = profileWithTools([["host_listOrders", "GET /api/orders"]]);
    for (const junk of [7, "", "   ", "interpretive dance", { sector: "finance" }]) {
      (profile.brand as Record<string, unknown>)["industry"] = junk;
      expect(pickStageArchetype(profile)).toBe("commerce");
    }
  });

  it("junk tool lists never crash the picker (tolerant profile parse lets anything in)", () => {
    const profile = profileFixture();
    (profile as Record<string, unknown>)["tools"] = { list: [null, "nope", { name: 7 }, { description: ["x"] }] };
    expect(pickStageArchetype(profile)).toBe("dashboard");
  });
});

describe("stageGreeting", () => {
  it("greets by product name, with the canvas possessive treatment", () => {
    expect(stageGreeting(profileFixture())).toBe("Hi, I'm Acme's agent.");
    const sName = profileFixture({ brand: { name: "Allbirds", domain: null, logoUrl: null } });
    expect(stageGreeting(sName)).toBe("Hi, I'm Allbirds' agent.");
  });

  it("stays grammatical with no brand name (zero-key / empty repo)", () => {
    expect(stageGreeting(null)).toBe("Hi, I'm this product's agent.");
    expect(stageGreeting(profileFixture({ brand: { name: "  ", domain: null, logoUrl: null } }))).toBe(
      "Hi, I'm this product's agent.",
    );
  });
});

describe("capabilityLine", () => {
  const archetypes: StageArchetype[] = ["dashboard", "finance", "commerce", "content", "docs"];

  it("one line per archetype, product-named, always ending in the acting-as-you clause", () => {
    const lines = archetypes.map((archetype) => capabilityLine(archetype, profileFixture()));
    expect(new Set(lines).size).toBe(archetypes.length);
    for (const line of lines) {
      expect(line).toMatch(/Acme's own (banking )?tools/);
      expect(line.endsWith("acting as you.")).toBe(true);
    }
  });

  it("keeps the canvas copy for the flagship archetypes", () => {
    expect(capabilityLine("dashboard", profileFixture())).toBe(
      "I can plan, triage, and report across this workspace using Acme's own tools, acting as you.",
    );
    expect(capabilityLine("finance", profileFixture())).toBe(
      "I can check accounts, explain your spending, and move money through Acme's own banking tools, acting as you.",
    );
  });

  it("neutral possessive without a brand name", () => {
    expect(capabilityLine("docs", null)).toContain("this product's own tools");
  });
});

describe("stageNavLabels", () => {
  it("derives labels from the extracted tool domains, topped up from defaults", () => {
    const profile = profileWithTools([
      ["host_listAccounts", "GET /api/accounts"],
      ["host_listCards", "GET /api/cards"],
    ]);
    expect(stageNavLabels("finance", profile)).toEqual(["Overview", "Accounts", "Cards", "Payments", "Insights"]);
  });

  it("pure defaults when there is no tool signal (empty repo still looks intentional)", () => {
    expect(stageNavLabels("finance", null)).toEqual(["Overview", "Accounts", "Payments", "Insights"]);
    expect(stageNavLabels("dashboard", profileFixture())).toEqual(["Overview", "Projects", "Reports", "Settings"]);
  });

  it("never duplicates a label and always leads with the archetype home link", () => {
    const profile = profileWithTools([["host_listProducts", "GET /api/products"]]);
    const labels = stageNavLabels("commerce", profile);
    expect(labels[0]).toBe("Shop");
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("selectSurfaceMode", () => {
  it("live only when the profile honestly reports the liveChat capability", () => {
    expect(selectSurfaceMode(profileFixture({ capabilities: { liveChat: true } }))).toBe("live");
  });

  it("scripted when liveChat is false, or there is no profile yet", () => {
    expect(selectSurfaceMode(profileFixture())).toBe("scripted");
    expect(selectSurfaceMode(null)).toBe("scripted");
  });

  it("scripted on malformed capabilities (tolerant profile parse lets anything in)", () => {
    const withCapabilities = (capabilities: unknown): TryProfile => {
      const profile = profileFixture();
      (profile as Record<string, unknown>)["capabilities"] = capabilities;
      return profile;
    };
    expect(selectSurfaceMode(withCapabilities(undefined))).toBe("scripted");
    expect(selectSurfaceMode(withCapabilities("yes"))).toBe("scripted");
    expect(selectSurfaceMode(withCapabilities({ liveChat: "true" }))).toBe("scripted");
    expect(selectSurfaceMode(withCapabilities({ liveChat: 1 }))).toBe("scripted");
  });
});

describe("liveToolMeta", () => {
  it("maps the profile's merged tool summaries into provider tool meta (name → description)", () => {
    const profile = profileFixture({
      tools: {
        list: [
          { name: "host_invoices_list", description: "List the signed-in user's invoices", risk: "read", disabled: false },
          { name: "host_invoice_send", description: "Send an invoice", risk: "write", disabled: true },
        ],
        counts: { total: 2, enabled: 1 },
      },
    });
    expect(liveToolMeta(profile)).toEqual({
      host_invoices_list: { description: "List the signed-in user's invoices" },
      host_invoice_send: { description: "Send an invoice" },
    });
  });

  it("drops junk/blank entries and answers empty for no profile (chrome's humanize fallback takes over)", () => {
    expect(liveToolMeta(null)).toEqual({});
    expect(liveToolMeta(profileFixture())).toEqual({});
    const profile = profileFixture();
    (profile as Record<string, unknown>)["tools"] = {
      list: [
        { name: "", description: "blank name" },
        { name: "host_ok", description: "   " },
        { name: 7, description: "non-string name" },
        "not even an object",
        { name: "host_good", description: "A real one" },
      ],
    };
    expect(liveToolMeta(profile)).toEqual({ host_good: { description: "A real one" } });
  });
});
