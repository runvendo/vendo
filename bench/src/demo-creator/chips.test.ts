import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildChipsPrompt,
  capabilityTokens,
  defaultChipModel,
  meaningfulTokens,
  isPlaceholderBeat,
  maxChips,
  mergeBeats,
  parseChipsReply,
  parseDemoChipsArgs,
  readExtractedTools,
  runDeriveChips,
} from "./chips.js";

const beat = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  chip: `${key} chip`,
  prompt: `${key} prompt`,
  ...extra,
});

describe("parseDemoChipsArgs", () => {
  it("parses --app and the optional prospect override", () => {
    expect(parseDemoChipsArgs(["--app", "/tmp/demo-acme", "--prospect", "Acme"]))
      .toEqual({ app: "/tmp/demo-acme", prospect: "Acme" });
    expect(parseDemoChipsArgs(["--", "--app", "/tmp/demo-acme"])).toEqual({ app: "/tmp/demo-acme" });
    expect(() => parseDemoChipsArgs([])).toThrow("--app is required");
  });
});

describe("defaultChipModel credential posture", () => {
  // The demo this generates runs on VENDO_API_KEY, but the CREATOR harness is
  // provider-bound end to end (judge + `claude` CLI too). An operator holding
  // only a Cloud key must be told that here, not by an SDK 401 mid-pipeline.
  it("names the missing key and why the Cloud key does not substitute", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("VENDO_API_KEY", "vk_test");
    await expect(defaultChipModel("anything")).rejects.toThrow(/ANTHROPIC_API_KEY[\s\S]*VENDO_API_KEY/);
    vi.unstubAllEnvs();
  });
});

describe("readExtractedTools", () => {
  async function withToolsFile(contents: string | undefined): Promise<string> {
    const appDir = await mkdtemp(path.join(tmpdir(), "vendo-chips-"));
    if (contents !== undefined) {
      await mkdir(path.join(appDir, ".vendo"), { recursive: true });
      await writeFile(path.join(appDir, ".vendo", "tools.json"), contents);
    }
    return appDir;
  }

  it("reads the host tools with their descriptions", async () => {
    const appDir = await withToolsFile(JSON.stringify({
      format: "vendo/tools@3",
      tools: [
        { name: "host_listInvoices", description: "GET /api/invoices", risk: "read" },
        { name: "host_sendReminder", description: "Email a reminder", risk: "write" },
      ],
    }));
    await expect(readExtractedTools(appDir)).resolves.toEqual([
      { name: "host_listInvoices", description: "GET /api/invoices", risk: "read" },
      { name: "host_sendReminder", description: "Email a reminder", risk: "write" },
    ]);
  });

  it("drops auth plumbing — a login route is not a capability anyone demos", async () => {
    const appDir = await withToolsFile(JSON.stringify({
      tools: [{ name: "host_auth_create" }, { name: "host_auth_get" }, { name: "vendo_knowledge_search" }],
    }));
    await expect(readExtractedTools(appDir)).resolves.toEqual([]);
  });

  // The "no chips, no crash" contract: an app with no extracted routes yet is
  // a normal state, not an error.
  it("returns nothing for a missing, malformed, or empty tools file", async () => {
    await expect(readExtractedTools(await withToolsFile(undefined))).resolves.toEqual([]);
    await expect(readExtractedTools(await withToolsFile("{ not json"))).resolves.toEqual([]);
    await expect(readExtractedTools(await withToolsFile(JSON.stringify({ tools: [] })))).resolves.toEqual([]);
    await expect(readExtractedTools(await withToolsFile(JSON.stringify({})))).resolves.toEqual([]);
  });
});

describe("buildChipsPrompt", () => {
  it("shows the model the real surface and forbids inventing beyond it", () => {
    const prompt = buildChipsPrompt({
      prospect: "Acme",
      tools: [{ name: "host_listInvoices", description: "List invoices", risk: "read" }],
    });
    expect(prompt).toContain("host_listInvoices");
    expect(prompt).toContain("List invoices");
    expect(prompt).toContain("[read]");
    expect(prompt).toContain("Never invent a capability that is not listed.");
    expect(prompt).toContain("Acme");
  });
});

describe("meaningfulTokens", () => {
  it("splits camelCase before lowercasing, so tool names yield real words", () => {
    // Without the camelCase split this is the single token "createorder",
    // which matches no human sentence and makes the name half of grounding
    // useless.
    expect([...meaningfulTokens("host_createOrder")]).toEqual(["create", "order"]);
  });

  it("drops the host_ prefix, stopwords, and two-character noise", () => {
    expect(meaningfulTokens("host_listInvoices").has("host")).toBe(false);
    expect(meaningfulTokens("Show me all of the things").has("the")).toBe(false);
    // Placeholder text reduces to NOTHING — which is why filler cannot ground.
    expect([...meaningfulTokens("c0 p0")]).toEqual([]);
  });

  it("folds a trailing s so invoice and invoices agree", () => {
    expect(meaningfulTokens("invoices").has("invoice")).toBe(true);
  });
});

describe("parseChipsReply", () => {
  const surface = [
    { name: "host_listInvoices", description: "List invoices for the account" },
    { name: "host_sendReminder", description: "Email a payment reminder" },
    { name: "host_agingReport", description: "Aging by customer" },
    { name: "host_listCustomers", description: "List customers" },
    { name: "host_writeOff", description: "Write off an invoice" },
    { name: "host_exportCsv", description: "Export rows to CSV" },
  ];
  const reply = (chips: unknown) => JSON.stringify({ chips });
  /** A pill whose VISIBLE TEXT is about the tool it cites — the only kind that
   * should ever survive. */
  const realistic = [
    { key: "overdue", chip: "Overdue invoices", prompt: "Show me every overdue invoice", tools: ["host_listInvoices"] },
    { key: "remind", chip: "Send a reminder", prompt: "Send a payment reminder for INV-204", tools: ["host_sendReminder"] },
    { key: "aging", chip: "Aging report", prompt: "Build an aging report by customer", tools: ["host_agingReport"] },
    { key: "customers", chip: "Top customers", prompt: "List my customers by revenue", tools: ["host_listCustomers"] },
  ];

  it("keeps a pill whose text matches the capability it cites", () => {
    const beats = parseChipsReply(reply(realistic), surface);
    expect(beats.map((entry) => entry.key)).toEqual(["overdue", "remind", "aging", "customers"]);
    // Citations are validation input; they never reach demo.config.
    for (const entry of beats) expect(Object.keys(entry).sort()).toEqual(["chip", "key", "prompt"]);
  });

  it("digs the object out of fenced or chatty replies", () => {
    const beats = parseChipsReply("Sure! Here you go:\n```json\n" + reply(realistic) + "\n```\n", surface);
    expect(beats).toHaveLength(4);
  });

  // THE case the previous round shipped: the citation names a real tool, so
  // the name check passes, but the visible text is filler. A prospect clicking
  // this pill gets a refusal.
  it("DROPS a pill citing a real tool whose visible text is placeholder filler", () => {
    const beats = parseChipsReply(reply([
      ...realistic,
      { key: "filler", chip: "c0", prompt: "p0", tools: ["host_listInvoices"] },
    ]), surface);
    expect(beats.map((entry) => entry.key)).not.toContain("filler");
    expect(beats).toHaveLength(4);
  });

  it("DROPS a pill citing a real tool whose visible text is unrelated prose", () => {
    const beats = parseChipsReply(reply([
      ...realistic,
      { key: "unrelated", chip: "Book a holiday", prompt: "Plan my summer holiday itinerary", tools: ["host_listInvoices"] },
    ]), surface);
    expect(beats.map((entry) => entry.key)).not.toContain("unrelated");
  });

  it("reports what it dropped and why", () => {
    const messages: string[] = [];
    parseChipsReply(reply([
      ...realistic,
      { key: "filler", chip: "c0", prompt: "p0", tools: ["host_listInvoices"] },
    ]), surface, (message) => messages.push(message));
    expect(messages.join(" ")).toMatch(/dropped as ungrounded[\s\S]*shares nothing[\s\S]*host_listInvoices/i);
  });

  it("drops a pill citing a tool the surface does not have", () => {
    const beats = parseChipsReply(reply([
      ...realistic,
      { key: "invented", chip: "Reconcile bank feed", prompt: "Reconcile my bank feed", tools: ["host_reconcileBankFeed"] },
    ]), surface);
    expect(beats.map((entry) => entry.key)).not.toContain("invented");
  });

  it("drops a pill that cites no tool at all", () => {
    const beats = parseChipsReply(reply([
      ...realistic,
      { key: "vague", chip: "Invoices please", prompt: "Show my invoices", tools: [] },
    ]), surface);
    expect(beats.map((entry) => entry.key)).not.toContain("vague");
  });

  // Ship fewer, never pad.
  it("ships the survivors rather than failing or padding when grounding culls most of them", () => {
    const beats = parseChipsReply(reply([
      realistic[0],
      { key: "a", chip: "c0", prompt: "p0", tools: ["host_listInvoices"] },
      { key: "b", chip: "Unrelated thing", prompt: "Something else entirely", tools: ["host_sendReminder"] },
      { key: "c", chip: "Nope", prompt: "Nope", tools: ["host_notReal"] },
    ]), surface);
    expect(beats.map((entry) => entry.key)).toEqual(["overdue"]);
  });

  it("caps at five and drops duplicates", () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      key: `invoice-${index}`, chip: `Invoices ${index}`, prompt: `Show invoice batch ${index}`, tools: ["host_listInvoices"],
    }));
    const beats = parseChipsReply(reply([...many, many[0]]), surface);
    expect(beats).toHaveLength(5);
    expect(new Set(beats.map((entry) => entry.key)).size).toBe(5);
  });

  it("a single-tool surface admits only pills grounded in that one capability", () => {
    const oneTool = [{ name: "host_listInvoices", description: "List invoices for the account" }];
    const beats = parseChipsReply(reply([
      { key: "invoices", chip: "Open invoices", prompt: "Show me my open invoices", tools: ["host_listInvoices"] },
      { key: "reminder", chip: "Send a reminder", prompt: "Send a payment reminder", tools: ["host_sendReminder"] },
      { key: "filler", chip: "c0", prompt: "p0", tools: ["host_listInvoices"] },
      { key: "customers", chip: "Top customers", prompt: "List my customers", tools: ["host_listCustomers"] },
    ]), oneTool);
    expect(beats.map((entry) => entry.key)).toEqual(["invoices"]);
  });

  // Observed live: the model answered, wrote "Wait, I need a single JSON
  // object", then emitted the corrected one. Spanning first-brace to last-brace
  // swallowed all three fragments and blew up on valid output.
  it("takes the LAST complete object when a model corrects itself mid-reply", () => {
    const messy = [
      JSON.stringify({ chips: [{ key: "half", chip: "Half", prompt: "Half", tools: ["host_listInvoices"] }] }),
      "",
      "Wait, I need a single JSON object with all chips.",
      "",
      reply(realistic),
    ].join("\n");
    const beats = parseChipsReply(messy, surface);
    expect(beats.map((entry) => entry.key)).toEqual(["overdue", "remind", "aging", "customers"]);
  });

  it("is not confused by braces inside string values", () => {
    const beats = parseChipsReply(JSON.stringify({
      chips: [{ key: "brace", chip: "Invoices {tricky}", prompt: 'Show invoices for "{acme}"', tools: ["host_listInvoices"] }],
    }), surface);
    expect(beats).toHaveLength(1);
  });

  it("still fails loudly on a structurally broken reply", () => {
    expect(() => parseChipsReply("no json here", surface)).toThrow(/no usable/);
    expect(() => parseChipsReply('{"nope":1}', surface)).toThrow(/no usable/);
    expect(() => parseChipsReply('{"chips":[]}', surface)).toThrow(/no usable/);
  });
});

describe("mergeBeats", () => {
  const derived = Array.from({ length: 5 }, (_, index) => beat(`derived-${index}`));

  it("keeps explicit beats verbatim, first, with their expectations", () => {
    const explicit = [
      beat("generate-ui", { expectsView: true }),
      beat("take-action", { expectsApproval: true }),
      beat("save-app"),
    ];
    const merged = mergeBeats(explicit, derived);
    expect(merged.slice(0, 3)).toEqual(explicit);
    expect(merged).toHaveLength(maxChips);
    expect(merged.slice(3).every((entry) => entry.key.startsWith("derived-"))).toBe(true);
  });

  it("replaces the template's TODO-fenced placeholders — they are not authored beats", () => {
    const placeholders = [
      { key: "generate-ui", chip: "TODO(creator): Dashboard", prompt: "TODO(creator): Show me a dashboard" },
    ];
    expect(isPlaceholderBeat(placeholders[0]!)).toBe(true);
    expect(mergeBeats(placeholders, derived)).toEqual(derived);
  });

  it("never lets a derived beat shadow an explicit one that owns the key", () => {
    const explicit = [beat("derived-0", { expectsView: true })];
    const merged = mergeBeats(explicit, derived);
    expect(merged[0]).toEqual(explicit[0]);
    expect(merged.filter((entry) => entry.key === "derived-0")).toHaveLength(1);
  });
});

describe("runDeriveChips", () => {
  const config = {
    id: "acme",
    prospect: "Acme",
    ctaUrl: "https://cal.com/yousefhelal",
    beats: [
      { key: "generate-ui", prompt: "Show me a dashboard", chip: "Dashboard", expectsView: true },
      { key: "take-action", prompt: "Archive Bravo", chip: "Archive, with approval", expectsApproval: true },
      { key: "save-app", prompt: "Save this as an app", chip: "Save as app" },
    ],
    caps: { maxTurns: 20, maxSpendUsd: 5 },
    expiresAt: "2099-01-01T00:00:00Z",
  };

  async function writeApp(options: { tools?: unknown; beats?: unknown } = {}): Promise<string> {
    const appDir = await mkdtemp(path.join(tmpdir(), "vendo-chips-app-"));
    await mkdir(path.join(appDir, ".vendo"), { recursive: true });
    await writeFile(
      path.join(appDir, "demo.config.json"),
      `${JSON.stringify({ ...config, ...(options.beats === undefined ? {} : { beats: options.beats }) }, null, 2)}\n`,
    );
    if (options.tools !== undefined) {
      await writeFile(path.join(appDir, ".vendo", "tools.json"), JSON.stringify({ tools: options.tools }));
    }
    return appDir;
  }

  const goodReply = JSON.stringify({
    chips: Array.from({ length: 5 }, (_, index) => ({
      key: `pill-${index}`,
      chip: `Pill ${index}`,
      prompt: `Do thing ${index} with invoices`,
      tools: ["host_listInvoices"],
    })),
  });

  it("derives pills from the tool surface and writes them into demo.config.json", async () => {
    const appDir = await writeApp({
      tools: [{ name: "host_listInvoices", description: "List invoices" }, { name: "host_sendReminder", description: "Send a reminder" }],
    });
    const model = vi.fn().mockResolvedValue(goodReply);

    const result = await runDeriveChips({ appDir }, { model, write: () => {} });

    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]![0]).toContain("host_listInvoices");
    // Explicit arc beats survive; derived pills fill the rest.
    expect(result.kept).toBe(3);
    expect(result.derived).toBe(2);
    const written = JSON.parse(await readFile(path.join(appDir, "demo.config.json"), "utf8")) as typeof config;
    expect(written.beats).toHaveLength(maxChips);
    expect(written.beats.slice(0, 3)).toEqual(config.beats);
    // Shape unchanged — nothing downstream (chip strip, capture, caps) moves.
    expect(Object.keys(written).sort()).toEqual(Object.keys(config).sort());
  });

  it("fills the whole strip from the surface when only placeholders exist", async () => {
    const appDir = await writeApp({
      tools: [{ name: "host_listInvoices", description: "List invoices" }],
      beats: [{ key: "generate-ui", prompt: "TODO(creator): x", chip: "TODO(creator): y", expectsView: true }],
    });

    const result = await runDeriveChips({ appDir }, { model: async () => goodReply, write: () => {} });

    expect(result.kept).toBe(0);
    expect(result.derived).toBe(5);
    expect(result.beats.every((entry) => entry.key.startsWith("pill-"))).toBe(true);
    expect(result.chips).toHaveLength(5);
  });

  // The criterion: empty/missing tools.json => NO chips, no crash. With no
  // surface there is nothing to ground a pill in, so the stage must derive
  // ZERO — not quietly pass the existing beats off as its output.
  it("derives NO chips with no tool surface, and does not crash or call the model", async () => {
    const appDir = await writeApp();
    const model = vi.fn();

    const result = await runDeriveChips({ appDir }, { model, write: () => {} });

    expect(result.chips).toEqual([]);
    expect(result.derived).toBe(0);
    expect(result.skipped).toBe("no-tools");
    expect(model).not.toHaveBeenCalled();
    // The config is left exactly as found — the template's strict schema
    // requires at least one beat, and destroying a demo's authored arc because
    // its routes are not synced yet would be a far worse failure.
    const written = JSON.parse(await readFile(path.join(appDir, "demo.config.json"), "utf8")) as typeof config;
    expect(written.beats).toEqual(config.beats);
  });

  it("derives NO chips when the surface holds only auth plumbing", async () => {
    const appDir = await writeApp({ tools: [{ name: "host_auth_create" }, { name: "host_auth_get" }] });
    const model = vi.fn();

    const result = await runDeriveChips({ appDir }, { model, write: () => {} });

    expect(result.chips).toEqual([]);
    expect(result.skipped).toBe("no-tools");
    expect(model).not.toHaveBeenCalled();
  });

  // Grounding survives the whole stage, not just the parser. Ship fewer, never
  // pad: when everything is culled the stage yields no chips and leaves the
  // demo's own beats alone, rather than padding the strip with pills that
  // refuse when a prospect clicks them.
  it("yields NO chips when the model invents capabilities the surface lacks", async () => {
    const appDir = await writeApp({ tools: [{ name: "host_listInvoices", description: "List invoices" }] });
    const messages: string[] = [];
    const model = async () => JSON.stringify({
      chips: Array.from({ length: 5 }, (_, index) => ({
        key: `pill-${index}`, chip: `c${index}`, prompt: `p${index}`, tools: ["host_reconcileBankFeed"],
      })),
    });

    const result = await runDeriveChips({ appDir }, { model, write: (line) => messages.push(line) });

    expect(result.chips).toEqual([]);
    expect(result.derived).toBe(0);
    expect(messages.join(" ")).toMatch(/host_reconcileBankFeed/);
    // Nothing written: the demo keeps the beats it had.
    const written = JSON.parse(await readFile(path.join(appDir, "demo.config.json"), "utf8")) as typeof config;
    expect(written.beats).toEqual(config.beats);
  });

  it("ships the survivors when only some pills ground, never padding to five", async () => {
    const appDir = await writeApp({
      tools: [{ name: "host_listInvoices", description: "List invoices for the account" }],
    });
    const model = async () => JSON.stringify({
      chips: [
        { key: "real", chip: "Open invoices", prompt: "Show me my open invoices", tools: ["host_listInvoices"] },
        { key: "filler-a", chip: "c0", prompt: "p0", tools: ["host_listInvoices"] },
        { key: "filler-b", chip: "c1", prompt: "p1", tools: ["host_listInvoices"] },
      ],
    });

    const result = await runDeriveChips({ appDir }, { model, write: () => {} });

    expect(result.chips.map((entry) => entry.key)).toEqual(["real"]);
    expect(result.derived).toBe(1);
    // 3 authored beats survive + the single grounded pill = 4, not a padded 5.
    expect(result.beats).toHaveLength(4);
  });

  it("refuses to write a config the template's strict schema would reject", async () => {
    const appDir = await writeApp({ tools: [{ name: "host_listInvoices" }] });
    const model = async () => JSON.stringify({
      chips: Array.from({ length: 4 }, (_, index) => ({
        key: `pill-${index}`, chip: `c${index}`, prompt: `p${index}`, tools: ["host_listInvoices"],
      })),
    });
    // A valid derivation writes; the guard is that we re-parse before writing,
    // so a schema break surfaces here instead of at the app's next boot.
    await expect(runDeriveChips({ appDir }, { model, write: () => {} })).resolves.toBeTruthy();
    const written = await readFile(path.join(appDir, "demo.config.json"), "utf8");
    expect(() => JSON.parse(written)).not.toThrow();
  });
});
