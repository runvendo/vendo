import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildChipsPrompt,
  defaultChipModel,
  meaningfulTokens,
  maxChips,
  mergeBeats,
  parseChipsReply,
  readExtractedTools,
} from "./chips.js";

const beat = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  chip: `${key} chip`,
  prompt: `${key} prompt`,
  ...extra,
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
  /** Returns the tools.json PATH: `vendo sync` writes it to `.vendo/tools.json`
   * while the demo folder keeps it at `demos/<slug>/tools.json`, so the reader
   * must hold no layout opinion. */
  async function withToolsFile(contents: string | undefined, name = "tools.json"): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-chips-"));
    const toolsPath = path.join(dir, name);
    if (contents !== undefined) await writeFile(toolsPath, contents);
    return toolsPath;
  }

  it("reads whatever tools.json path it is given", async () => {
    const synced = await withToolsFile(
      JSON.stringify({ tools: [{ name: "host_listInvoices" }] }),
      "synced-tools.json",
    );
    await expect(readExtractedTools(synced)).resolves.toEqual([{ name: "host_listInvoices" }]);
  });

  it("reads the host tools with their descriptions", async () => {
    const toolsPath = await withToolsFile(JSON.stringify({
      format: "vendo/tools@3",
      tools: [
        { name: "host_listInvoices", description: "GET /api/invoices", risk: "read" },
        { name: "host_sendReminder", description: "Email a reminder", risk: "write" },
      ],
    }));
    await expect(readExtractedTools(toolsPath)).resolves.toEqual([
      { name: "host_listInvoices", description: "GET /api/invoices", risk: "read" },
      { name: "host_sendReminder", description: "Email a reminder", risk: "write" },
    ]);
  });

  it("drops auth plumbing — a login route is not a capability anyone demos", async () => {
    const toolsPath = await withToolsFile(JSON.stringify({
      tools: [{ name: "host_auth_create" }, { name: "host_auth_get" }, { name: "vendo_knowledge_search" }],
    }));
    await expect(readExtractedTools(toolsPath)).resolves.toEqual([]);
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

  it("keeps existing beats verbatim, first, with their expectations", () => {
    const existing = [
      beat("generate-ui", { expectsView: true }),
      beat("take-action", { expectsApproval: true }),
      beat("save-app"),
    ];
    const merged = mergeBeats(existing, derived);
    expect(merged.slice(0, 3)).toEqual(existing);
    expect(merged).toHaveLength(maxChips);
    expect(merged.slice(3).every((entry) => entry.key.startsWith("derived-"))).toBe(true);
  });

  it("never lets a derived beat shadow an existing one that owns the key", () => {
    const existing = [beat("derived-0", { expectsView: true })];
    const merged = mergeBeats(existing, derived);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged.filter((entry) => entry.key === "derived-0")).toHaveLength(1);
  });

  // `[...existing]` copied authored beats verbatim, duplicates included: the
  // `taken` set only ever stopped a DERIVED collision.
  it("drops an authored duplicate key, keeping the first", () => {
    const existing = [
      beat("generate-ui", { expectsView: true }),
      beat("automation", { chip: "First automation" }),
      beat("automation", { chip: "Second automation" }),
    ];
    const merged = mergeBeats(existing, []);
    expect(merged.filter((entry) => entry.key === "automation")).toHaveLength(1);
    expect(merged.find((entry) => entry.key === "automation")?.chip).toBe("First automation");
  });

  // The duplicate a prospect actually SEES: regrounding rewrites an authored
  // beat's wording with a derived pill but keeps its key, and merging then
  // appended that same pill again under its own key — two chips, one sentence.
  it("never appends a pill whose wording an existing beat already carries", () => {
    const pill = beat("lanes", { chip: "Shipments by lane", prompt: "Show me every shipment grouped by lane" });
    const existing = [
      { ...beat("generate-ui", { expectsView: true }), chip: pill.chip, prompt: pill.prompt },
      beat("take-action", { expectsApproval: true }),
    ];
    const merged = mergeBeats(existing, [pill]);
    expect(merged.map((entry) => entry.prompt)).toEqual([pill.prompt, "take-action prompt"]);
  });

  it("never returns more beats than the strip can show, even from authored ones alone", () => {
    const existing = Array.from({ length: 7 }, (_, index) => beat(`authored-${index}`));
    expect(mergeBeats(existing, derived)).toHaveLength(maxChips);
  });
});
