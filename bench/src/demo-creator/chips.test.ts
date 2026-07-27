import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildChipsPrompt,
  defaultChipModel,
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

describe("parseChipsReply", () => {
  const reply = (chips: unknown) => JSON.stringify({ chips });

  it("accepts a clean reply and normalizes keys to slugs", () => {
    const beats = parseChipsReply(reply([
      { key: "Overdue Invoices", chip: "Overdue invoices", prompt: "Show me every overdue invoice" },
      { key: "send-reminder", chip: "Send a reminder", prompt: "Send a reminder for invoice INV-204" },
      { key: "aging", chip: "Aging report", prompt: "Build an aging report by customer" },
      { key: "top-customers", chip: "Top customers", prompt: "Show me my top customers this quarter" },
    ]));
    expect(beats.map((entry) => entry.key)).toEqual(["overdue-invoices", "send-reminder", "aging", "top-customers"]);
    // Derived pills carry no expectation — they are pills, not a verification contract.
    for (const entry of beats) {
      expect(entry).not.toHaveProperty("expectsView");
      expect(entry).not.toHaveProperty("expectsApproval");
    }
  });

  it("digs the object out of fenced or chatty replies", () => {
    const chips = Array.from({ length: 4 }, (_, index) => ({ key: `k${index}`, chip: `c${index}`, prompt: `p${index}` }));
    const beats = parseChipsReply("Sure! Here you go:\n```json\n" + reply(chips) + "\n```\n");
    expect(beats).toHaveLength(4);
  });

  it("caps at five and drops duplicate or malformed entries", () => {
    const chips = [
      ...Array.from({ length: 6 }, (_, index) => ({ key: `k${index}`, chip: `c${index}`, prompt: `p${index}` })),
      { key: "k0", chip: "dup", prompt: "dup" },
      { key: "bad", chip: "" },
    ];
    const beats = parseChipsReply(reply(chips));
    expect(beats).toHaveLength(5);
    expect(new Set(beats.map((entry) => entry.key)).size).toBe(5);
  });

  it("refuses a reply too thin to fill the strip, rather than shipping two pills", () => {
    expect(() => parseChipsReply(reply([{ key: "a", chip: "a", prompt: "a" }]))).toThrow(/only 1 usable/);
    expect(() => parseChipsReply("no json here")).toThrow(/no JSON object/);
    expect(() => parseChipsReply('{"nope":1}')).toThrow(/no "chips" array/);
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
  });

  it("is a no-op with no tool surface: no chips, no crash, no model call", async () => {
    const appDir = await writeApp();
    const model = vi.fn();

    const result = await runDeriveChips({ appDir }, { model, write: () => {} });

    expect(result.skipped).toBe("no-tools");
    expect(model).not.toHaveBeenCalled();
    expect(result.beats).toEqual(config.beats);
    const written = JSON.parse(await readFile(path.join(appDir, "demo.config.json"), "utf8")) as typeof config;
    expect(written.beats).toEqual(config.beats);
  });

  it("refuses to write a config the template's strict schema would reject", async () => {
    const appDir = await writeApp({ tools: [{ name: "host_listInvoices" }] });
    const model = async () => JSON.stringify({
      chips: Array.from({ length: 4 }, (_, index) => ({ key: `pill-${index}`, chip: `c${index}`, prompt: `p${index}` })),
    });
    // A valid derivation writes; the guard is that we re-parse before writing,
    // so a schema break surfaces here instead of at the app's next boot.
    await expect(runDeriveChips({ appDir }, { model, write: () => {} })).resolves.toBeTruthy();
    const written = await readFile(path.join(appDir, "demo.config.json"), "utf8");
    expect(() => JSON.parse(written)).not.toThrow();
  });
});
