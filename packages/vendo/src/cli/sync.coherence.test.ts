import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSync } from "./sync.js";

/**
 * `vendo sync` coherence (init/sync lane, 2026-08-02): the AI flag matrix that
 * matches init's exactly, the theme re-scan that never clobbers a hand edit,
 * and the pin-baseline reconcile with Vendo Cloud.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const REPORT = {
  tools: { added: [], removed: [], changed: [] },
  breaking: [],
  pins: { captured: [], drifted: [] },
  remixableErrors: [],
  catalog: { discovered: 0, registered: 0 },
  components: { captured: [], drifted: [] },
  warnings: [],
};

const scan = async () => REPORT;

function captureOutput() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }, logs, errors };
}

const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;

async function host(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vendo-sync-coherence-"));
  dirs.push(dir);
  await mkdir(join(dir, ".vendo"), { recursive: true });
  return dir;
}

/** A harness that fails loudly if the judgment pass so much as probes it. */
const forbidden = {
  id: "never",
  availability: async () => { throw new Error("the judgment pass must not run here"); },
  run: async () => { throw new Error("the judgment pass must not run here"); },
};

describe("the AI flag matrix on sync (identical to init's)", () => {
  it("interactive with no flag ASKS, every run — nothing is persisted", async () => {
    const dir = await host();
    for (const pass of [1, 2]) {
      const asked: string[] = [];
      const messages = captureOutput();
      expect(await runSync({
        targetDir: dir,
        output: messages.output,
        fetchImpl: offline,
        sync: scan,
        interactive: true,
        judge: {
          harnesses: [forbidden],
          confirm: async (question: string) => { asked.push(question); return false; },
        },
      })).toBe(0);
      expect(asked.length, `run ${pass} asked`).toBe(1);
      expect(asked[0]).toContain("Let a coding agent read this codebase");
    }
  });

  it("non-interactive with no flag never prompts and never runs the pass", async () => {
    const messages = captureOutput();
    expect(await runSync({
      targetDir: await host(),
      output: messages.output,
      fetchImpl: offline,
      sync: scan,
      interactive: false,
      judge: {
        harnesses: [forbidden],
        confirm: async () => { throw new Error("prompted in a non-interactive run"); },
      },
    })).toBe(0);
    expect(messages.logs.join("\n")).toContain("judgment: skipped — this run cannot ask");
  });

  it("--yes and --json are non-interactive by construction: neither ever prompts", async () => {
    for (const flags of [{ yes: true }, { json: true }] as const) {
      const messages = captureOutput();
      expect(await runSync({
        targetDir: await host(),
        output: messages.output,
        fetchImpl: offline,
        sync: scan,
        ...flags,
        judge: {
          harnesses: [forbidden],
          confirm: async () => { throw new Error("prompted") },
        },
      })).toBe(0);
    }
  });

  it("--json still emits exactly one object", async () => {
    const messages = captureOutput();
    expect(await runSync({
      targetDir: await host(),
      output: messages.output,
      fetchImpl: offline,
      sync: scan,
      json: true,
      judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted") } },
    })).toBe(0);
    expect(messages.logs).toHaveLength(1);
    const result = JSON.parse(messages.logs[0]!) as { theme: unknown; baselines: unknown };
    expect(result.theme).toBeNull();
    expect(result.baselines).toBeNull();
  });

  // I1 (review): existing installs have a bare `predev: vendo sync`. npm
  // inherits the terminal, so without this exemption `npm run dev` blocks on a
  // default-yes prompt and a reflexive Enter starts spending.
  it("a package-script run is never interactive, even with a TTY", async () => {
    vi.stubEnv("npm_lifecycle_event", "predev");
    // A REAL TTY, or the assertion is vacuous: this is exactly the shape
    // `npm run dev` hands its predev hook.
    const tty = { in: process.stdin.isTTY, out: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    const messages = captureOutput();
    expect(await runSync({
      targetDir: await host(),
      output: messages.output,
      fetchImpl: offline,
      sync: scan,
      judge: {
        harnesses: [forbidden],
        confirm: async () => { throw new Error("prompted inside an npm lifecycle hook"); },
      },
    }).finally(() => {
      process.stdin.isTTY = tty.in;
      process.stdout.isTTY = tty.out;
    })).toBe(0);
    expect(messages.logs.join("\n")).toContain("judgment: skipped — this run cannot ask");
  });

  it("--no-ai forces the pass off in an interactive run too", async () => {
    const messages = captureOutput();
    expect(await runSync({
      targetDir: await host(),
      output: messages.output,
      fetchImpl: offline,
      sync: scan,
      ai: false,
      interactive: true,
      judge: { harnesses: [forbidden], confirm: async () => { throw new Error("prompted") } },
    })).toBe(0);
    expect(messages.logs.join("\n")).not.toContain("judgment");
  });
});

describe("the theme re-scan (decision 3)", () => {
  /** A host whose CSS declares a brand, plus the theme.json + merge base a
      prior `vendo init` would have written from exactly that CSS. */
  async function themedHost(accent: string): Promise<string> {
    const dir = await host();
    await mkdir(join(dir, "app"), { recursive: true });
    await writeFile(join(dir, "app", "layout.tsx"), 'import "./globals.css";\nexport default () => null;\n', "utf8");
    await writeFile(join(dir, "app", "globals.css"),
      `:root { --primary: ${accent}; --background: #ffffff; --radius: 8px; }\n`, "utf8");
    return dir;
  }

  const themeJson = (accent: string, extra: Record<string, unknown> = {}) => ({
    colors: {
      background: "#ffffff", surface: "#f8fafc", text: "#0f172a", muted: "#64748b",
      accent, accentText: "#ffffff", danger: "#dc2626", border: "#e2e8f0",
    },
    typography: { fontFamily: "system-ui, sans-serif", headingFamily: "system-ui, sans-serif", baseSize: "16px" },
    radius: { small: "4px", medium: "8px", large: "12px" },
    density: "comfortable",
    motion: "full",
    ...extra,
  });

  const writeTheme = (dir: string, theme: unknown) =>
    writeFile(join(dir, ".vendo", "theme.json"), `${JSON.stringify(theme, null, 2)}\n`, "utf8");
  const writeBase = (dir: string, slots: Record<string, string>) =>
    writeFile(join(dir, ".vendo", "theme.extracted.json"),
      `${JSON.stringify({ format: "vendo/theme-extracted@1", at: "2026-01-01T00:00:00.000Z", slots }, null, 2)}\n`, "utf8");

  const read = async (dir: string) =>
    JSON.parse(await readFile(join(dir, ".vendo", "theme.json"), "utf8")) as ReturnType<typeof themeJson>;

  it("takes a rebrand: a machine-extracted slot follows the host's new CSS", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#7c3bed"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect((await read(dir)).colors.accent).toBe("#0f766e");
    expect(messages.logs.join("\n")).toContain("theme: 1 slot re-read from your app (accent)");
  });

  it("leaves a HAND-EDITED slot alone and reports it as pinned", async () => {
    const dir = await themedHost("#0f766e");
    // theme.json says #ff0000, the base says the machine last read #7c3bed:
    // the value on disk is a human's, so the new #0f766e must not land.
    await writeTheme(dir, themeJson("#ff0000"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect((await read(dir)).colors.accent).toBe("#ff0000");
    const logs = messages.logs.join("\n");
    expect(logs).toContain("1 pinned by you, unchanged (accent — yours #ff0000 vs your app's #0f766e)");
    expect(logs).toContain("--theme-refresh");
    // The base does NOT advance while a disagreement is unresolved, so the
    // warning repeats instead of quietly becoming the new truth.
    expect(JSON.parse(await readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")))
      .toMatchObject({ slots: { accent: "#7c3bed" } });
  });

  it("--theme-refresh takes the pinned slot and records the new base", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#ff0000"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    expect(await runSync({
      targetDir: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false, themeRefresh: true,
    })).toBe(0);
    expect((await read(dir)).colors.accent).toBe("#0f766e");
    expect(JSON.parse(await readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")))
      .toMatchObject({ slots: { accent: "#0f766e" } });
  });

  it("with no merge base nothing is machine-owned: the file is untouched and the diff is loud", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#7c3bed"));
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect((await read(dir)).colors.accent).toBe("#7c3bed");
    expect(messages.logs.join("\n")).toContain("1 pinned by you, unchanged (accent — yours #7c3bed vs your app's #0f766e)");
  });

  // BLOCKER 2 (review): the neutral defaults are ordinary Tailwind palette
  // values — #2563eb is blue-600 — so "it equals our default" is NOT proof the
  // machine wrote it. Every existing install takes this upgrade path.
  it("a human value that happens to equal Vendo's neutral default is still pinned", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#2563eb")); // blue-600: our default AND a real brand choice
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect((await read(dir)).colors.accent).toBe("#2563eb");
    const logs = messages.logs.join("\n");
    expect(logs).toContain("1 pinned by you, unchanged (accent — yours #2563eb vs your app's #0f766e)");
    expect(logs).not.toContain("re-read from your app");
    // And no base was written, so the warning repeats rather than baking in.
    await expect(readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")).rejects.toThrow();
  });

  it("an unrecorded slot is pinned even when the base exists for other slots", async () => {
    const dir = await themedHost("#7c3bed");
    // The base knows accent; nothing was ever recorded for background.
    await writeTheme(dir, { ...themeJson("#7c3bed"), colors: { ...themeJson("#7c3bed").colors, background: "#101010" } });
    await writeBase(dir, { accent: "#7c3bed" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect((await read(dir)).colors.background).toBe("#101010");
    expect(messages.logs.join("\n")).toContain("1 pinned by you, unchanged (background — yours #101010 vs your app's #ffffff)");
  });

  // BLOCKER 1 (review): .vendo/ is committed and predev runs sync, so a base
  // that rewrites itself every run dirties every contributor's tree.
  it("two consecutive no-op syncs leave theme.extracted.json byte-identical", async () => {
    const dir = await themedHost("#7c3bed");
    await writeTheme(dir, themeJson("#7c3bed"));
    const basePath = join(dir, ".vendo", "theme.extracted.json");
    expect(await runSync({ targetDir: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    const first = await readFile(basePath, "utf8");
    expect(await runSync({ targetDir: dir, output: captureOutput().output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect(await readFile(basePath, "utf8")).toBe(first);
    // No timestamp: the file carries decisions, nothing else.
    expect(JSON.parse(first)).toEqual({ format: "vendo/theme-extracted@1", slots: expect.any(Object) });
  });

  // N1 (review): most of the demo-app noise was hex casing.
  it("compares colors by meaning: #FFFFFF and #ffffff are not a hand edit", async () => {
    const dir = await themedHost("#7C3BED");
    await writeTheme(dir, themeJson("#7c3bed"));
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect(messages.logs.join("\n")).not.toContain("theme:");
  });

  it("bootstraps the base silently when the scan and theme.json already agree", async () => {
    const dir = await themedHost("#7c3bed");
    await writeTheme(dir, themeJson("#7c3bed"));
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    expect(messages.logs.join("\n")).not.toContain("theme:");
    expect(JSON.parse(await readFile(join(dir, ".vendo", "theme.extracted.json"), "utf8")))
      .toMatchObject({ slots: { accent: "#7c3bed" } });
  });

  // Review round 2: the summary line must be literally true. It named slots
  // whose BASE moved as "re-read from your app", so a user with a pinned
  // accent was told their accent now tracks their CSS. It did not.
  it("names exactly the slots written, and reports the pinned ones separately", async () => {
    const dir = await themedHost("#0f766e");
    // background is hand-edited (pinned); accent is machine-owned (written).
    const start = themeJson("#7c3bed");
    await writeTheme(dir, { ...start, colors: { ...start.colors, background: "#101010" } });
    await writeBase(dir, { accent: "#7c3bed", accentText: "#ffffff", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false, json: true })).toBe(0);
    const line = (JSON.parse(messages.logs[0]!) as { notes: string[] }).notes.find((n) => n.startsWith("theme:"))!;

    // Written: accent only — and the pinned slot is NOT in the re-read list.
    expect(line).toContain("1 slot re-read from your app (accent) → .vendo/theme.json");
    expect(line).not.toContain("re-read from your app (accent, background)");
    // Pinned: named separately, with BOTH values so it cannot read as "border
    // now tracks your CSS".
    expect(line).toContain("1 pinned by you, unchanged (background — yours #101010 vs your app's #ffffff)");

    const after = await read(dir);
    expect(after.colors.accent).toBe("#0f766e"); // written, as reported
    expect(after.colors.background).toBe("#101010"); // pinned, as reported
    expect(JSON.parse(messages.logs[0]!).theme).toEqual({ updated: ["accent"], pinned: ["background"] });
  });

  // The defect underneath the wrong label: a DERIVED slot followed the app's
  // source while the source itself stayed pinned, so the human's dark accent
  // got black text written on it.
  it("holds a derived slot when the slot it derives from is pinned", async () => {
    // The app's accent is light, so its contrast text is black — but the human
    // pinned a DARK accent, whose contrast text must stay white.
    const dir = await themedHost("#fde047");
    await writeTheme(dir, themeJson("#2563eb"));
    await writeBase(dir, { accent: "#7c3bed", accentText: "#ffffff", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    const after = await read(dir);
    expect(after.colors.accent).toBe("#2563eb");
    expect(after.colors.accentText).toBe("#ffffff"); // NOT #000000 on dark blue
    expect(messages.logs.join("\n")).not.toContain("accentText");
  });

  it("a derived slot DOES follow its source when the source is machine-owned", async () => {
    const dir = await themedHost("#fde047");
    await writeTheme(dir, themeJson("#7c3bed"));
    await writeBase(dir, { accent: "#7c3bed", accentText: "#ffffff", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false })).toBe(0);
    const after = await read(dir);
    expect(after.colors.accent).toBe("#fde047");
    expect(after.colors.accentText).toBe("#000000"); // correct contrast on yellow
    expect(messages.logs.join("\n")).toContain("2 slots re-read from your app (accent, accentText)");
  });

  it("reports both halves in --json", async () => {
    const dir = await themedHost("#0f766e");
    await writeTheme(dir, themeJson("#ff0000"));
    await writeBase(dir, { accent: "#7c3bed", background: "#ffffff", radius: "8px" });
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false, json: true })).toBe(0);
    expect(JSON.parse(messages.logs[0]!).theme).toEqual({ updated: [], pinned: ["accent"] });
  });

  it("a host with no theme.json is left alone (init owns creating it)", async () => {
    const dir = await themedHost("#0f766e");
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, fetchImpl: offline, sync: scan, ai: false, json: true })).toBe(0);
    expect(JSON.parse(messages.logs[0]!).theme).toBeNull();
  });
});

describe("pin baselines reach Vendo Cloud (decision 4)", () => {
  const baseline = (slot: string, hash: string) => ({
    slot,
    source: `export function ${slot}() { return null; }`,
    hash: `sha256:${hash}`,
    exportable: false,
    capturedAt: "2026-08-02T00:00:00.000Z",
    review: true,
  });

  async function hostWithBaselines(slots: Array<{ slot: string; hash: string }>): Promise<string> {
    const dir = await host();
    await mkdir(join(dir, ".vendo", "remixable"), { recursive: true });
    for (const { slot, hash } of slots) {
      await writeFile(join(dir, ".vendo", "remixable", `${slot}.json`),
        `${JSON.stringify(baseline(slot, hash), null, 2)}\n`, "utf8");
    }
    return dir;
  }

  /** The public store door as the console sees it: one records collection. */
  function fakeStore(seed: Record<string, unknown> = {}) {
    const rows = new Map<string, unknown>(Object.entries(seed));
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      const body = JSON.parse(String(init?.body ?? "{}")) as { record?: { id: string; data: unknown }; id?: string };
      const stamp = { createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z" };
      if (path.endsWith("/list")) {
        return new Response(JSON.stringify({
          records: [...rows.entries()].map(([id, data]) => ({ id, data, ...stamp })),
        }), { status: 200 });
      }
      if (path.endsWith("/put")) {
        rows.set(body.record!.id, body.record!.data);
        return new Response(JSON.stringify({ record: { ...body.record, ...stamp } }), { status: 200 });
      }
      if (path.endsWith("/delete")) {
        rows.delete(body.id!);
        return new Response(JSON.stringify({}), { status: 200 });
      }
      throw new Error(`unexpected store call ${path}`);
    }) as unknown as typeof fetch;
    return { fetchImpl, rows, calls };
  }

  it("pushes the captured baseline verbatim through the public store door", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const store = fakeStore();
    const messages = captureOutput();
    expect(await runSync({
      targetDir: dir,
      output: messages.output,
      sync: scan,
      ai: false,
      apiKey: "vnd_" + "a".repeat(40),
      apiUrl: "https://console.test",
      fetchImpl: store.fetchImpl,
    })).toBe(0);
    // The collection the console reads, and the exact shape it validates.
    expect(store.calls.some((path) => path.includes("/api/v1/store/records/vendo_pin_baselines"))).toBe(true);
    expect(store.rows.get("NetWorthCard")).toEqual(baseline("NetWorthCard", "aa"));
    expect(messages.logs.join("\n")).toContain("baselines → Vendo Cloud: 1 pushed, 0 pruned");
  });

  it("prunes remotely what is pruned locally, and re-pushes nothing unchanged", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const store = fakeStore({
      NetWorthCard: baseline("NetWorthCard", "aa"),   // already current
      LegacyHeroCard: baseline("LegacyHeroCard", "bb"), // no local file anymore
    });
    const messages = captureOutput();
    expect(await runSync({
      targetDir: dir, output: messages.output, sync: scan, ai: false, json: true,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: store.fetchImpl,
    })).toBe(0);
    expect(JSON.parse(messages.logs[0]!).baselines).toEqual({ pushed: [], pruned: ["LegacyHeroCard"] });
    expect([...store.rows.keys()]).toEqual(["NetWorthCard"]);
    expect(store.calls.filter((path) => path.endsWith("/put"))).toEqual([]);
  });

  it("keyless/BYO stays local: no request is made at all", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const fetchImpl = vi.fn(async () => { throw new Error("keyless sync must never call the network"); }) as unknown as typeof fetch;
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, sync: scan, ai: false, json: true, fetchImpl })).toBe(0);
    expect(JSON.parse(messages.logs[0]!).baselines).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keyless with captures SAYS the baselines stayed local", async () => {
    vi.stubEnv("VENDO_API_KEY", "");
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const messages = captureOutput();
    expect(await runSync({ targetDir: dir, output: messages.output, sync: scan, ai: false })).toBe(0);
    expect(messages.logs.join("\n")).toContain("baselines stay local");
  });

  it("a Cloud hiccup is a warning, never a failed build", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const messages = captureOutput();
    expect(await runSync({
      targetDir: dir, output: messages.output, sync: scan, ai: false, strict: true,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test",
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    })).toBe(0);
    expect(messages.errors.join("\n")).toContain("pin baselines did not fully reach Vendo Cloud");
    expect(messages.errors.join("\n")).toContain("the next sync retries");
  });

  // BLOCKER 3 (review): a half-written capture on one laptop must never wipe
  // the console's review baseline. Presence of the FILE is the prune signal.
  it("a corrupt local baseline is skipped and warned — never a delete", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    await writeFile(join(dir, ".vendo", "remixable", "SpendingDonut.json"), '{"slot":"SpendingD', "utf8");
    const store = fakeStore({
      NetWorthCard: baseline("NetWorthCard", "aa"),
      SpendingDonut: baseline("SpendingDonut", "cc"),
    });
    const messages = captureOutput();
    expect(await runSync({
      targetDir: dir, output: messages.output, sync: scan, ai: false, json: true,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: store.fetchImpl,
    })).toBe(0);
    // The truncated slot's row survives untouched, and nothing was pruned.
    expect([...store.rows.keys()].sort()).toEqual(["NetWorthCard", "SpendingDonut"]);
    const corrupt = JSON.parse(messages.logs[0]!) as { baselines: unknown; notes: string[] };
    expect(corrupt.baselines).toEqual({ pushed: [], pruned: [] });
    expect(corrupt.notes.join("\n")).toContain("unreadable baselines left untouched in Vendo Cloud: SpendingDonut");
  });

  // N3 (review): a mid-loop transport failure must not report `null` over rows
  // that really did land.
  it("keeps partial accounting when the transport dies mid-reconcile", async () => {
    const dir = await hostWithBaselines([
      { slot: "AaaCard", hash: "aa" },
      { slot: "BbbCard", hash: "bb" },
    ]);
    const store = fakeStore();
    let puts = 0;
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/put") && ++puts === 2) throw new Error("ECONNRESET");
      return store.fetchImpl(url as never, init as never);
    }) as unknown as typeof fetch;
    const messages = captureOutput();
    expect(await runSync({
      targetDir: dir, output: messages.output, sync: scan, ai: false, json: true,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: flaky,
    })).toBe(0);
    // AaaCard landed and is still reported; BbbCard did not.
    const partial = JSON.parse(messages.logs[0]!) as { baselines: unknown; notes: string[] };
    expect(partial.baselines).toEqual({ pushed: ["AaaCard"], pruned: [] });
    expect(partial.notes.join("\n")).toContain("did not fully reach Vendo Cloud");
  });

  // I2 (review): 30s per request x N slots could add minutes to a prebuild.
  it("bails out on one overall budget instead of stalling a build", async () => {
    const dir = await hostWithBaselines([{ slot: "NetWorthCard", hash: "aa" }]);
    const messages = captureOutput();
    const hang = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await runSync({
      targetDir: dir, output: messages.output, sync: scan, ai: false,
      apiKey: "vnd_" + "a".repeat(40), apiUrl: "https://console.test", fetchImpl: hang,
      baselineBudgetMs: 150,
    })).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(messages.errors.join("\n")).toContain("budget");
  });
});
