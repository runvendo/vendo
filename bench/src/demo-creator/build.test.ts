import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertDisjointOwnership, type AgentRunResult, type RunAgentFn } from "./agent.js";
import type { BrandBrief } from "./brief.js";
import {
  buildAgentJobs,
  buildBudgetCeilingUsd,
  domainApi,
  regroundBeats,
  repairBudgetUsd,
  runBuild,
  syncTools,
  writeJsonAtomic,
  ungroundedBeats,
} from "./build.js";
import { maxChips } from "./chips.js";
import { demoPaths, parseDemoFolderConfig, requiredBeatKeys, type DemoTheme } from "./demo-folder.js";
import type { ExecFn } from "./exec.js";

const slug = "cadence";

const brief: BrandBrief = {
  company: "Cadence",
  oneLiner: "Bookkeeping for design studios.",
  productSurface: "The invoices list",
  referenceScreenshot: "RESEARCH/invoices.png",
  nav: ["Invoices", "Clients", "Reports"],
  vocabulary: ["invoice", "retainer", "studio"],
  voice: "Terse, lowercase labels, no exclamation marks.",
  entities: [
    {
      name: "Invoice",
      stem: "invoices",
      action: "voidInvoice",
      fields: ["total: cents", "status: draft | sent | paid"],
      sampleRecordNames: ["INV-2041 Northwind Studio", "INV-2044 Harbour Type"],
    },
  ],
  chipMaterial: ["overdue invoices by studio", "void the oldest unpaid invoice"],
  placement: { trigger: "header", slot: "beside the Invoices header actions" },
  themeNotes: ["accent copied from the wordmark"],
};

const theme: DemoTheme = {
  colors: {
    background: "#FFFFFF", surface: "#FBFBFA", text: "#111111", muted: "#908C85",
    accent: "#1F6FEB", accentText: "#FFFFFF", danger: "#B42318", border: "#ECEBE8",
  },
  typography: { fontFamily: "Inter", baseSize: "14px" },
  radius: { small: "4px", medium: "8px", large: "12px" },
  density: "compact",
  motion: "full",
};

const jobOptions = { slug, prospect: "Cadence", brief, ctaUrl: "https://cal.com/yousefhelal", expiresAt: "2026-08-31T00:00:00Z" };

/** A demo.config.json as the beats agent would leave it. */
function agentConfig(keys: readonly string[] = requiredBeatKeys): Record<string, unknown> {
  return {
    id: slug,
    prospect: "Cadence",
    ctaUrl: "https://example.com/wrong",
    caps: { maxTurns: 20, maxSpendUsd: 5 },
    expiresAt: "2099-01-01T00:00:00Z",
    placement: brief.placement,
    beats: keys.map((key) => ({
      key,
      chip: `${key} invoices`,
      prompt: `Do the ${key} thing with overdue invoices`,
      ...(key === "generate-ui" ? { expectsView: true } : {}),
      ...(key === "take-action" ? { expectsApproval: true } : {}),
    })),
  };
}

async function demoFolder(options: { config?: Record<string, unknown> } = {}): Promise<string> {
  const demosRepo = await mkdtemp(path.join(tmpdir(), "vendo-demos-"));
  const paths = demoPaths(demosRepo, slug);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.config, `${JSON.stringify(options.config ?? agentConfig(), null, 2)}\n`);
  return demosRepo;
}

const agentOk = (name: string): AgentRunResult => ({ name, code: 0, output: "done", costUsd: 1.5, timedOut: false, permissionDenials: [] });

/** `vendo sync`'s real behaviour: writes `<demoDir>/.vendo/{tools,catalog}.json`. */
function fakeSync(names: readonly string[]): ExecFn {
  return async (command) => {
    const target = command[3] as string;
    await mkdir(path.join(target, ".vendo"), { recursive: true });
    await writeFile(
      path.join(target, ".vendo", "tools.json"),
      JSON.stringify({ format: "vendo/tools@3", tools: names.map((name) => ({ name, description: `${name} route` })) }),
    );
    await writeFile(path.join(target, ".vendo", "catalog.json"), "{}");
    return { code: 0, stdout: "tools: +2 -0 ~0", stderr: "" };
  };
}

const chipReply = (chips: unknown): string => JSON.stringify({ chips });

const groundedChips = chipReply([
  { key: "overdue", chip: "Overdue invoices", prompt: "Show me every overdue invoice", tools: ["host_listInvoices"] },
]);

const shipmentTools = [
  { name: "host_listShipments", description: "List every shipment" },
  { name: "host_flagShipment", description: "Flag one shipment for review" },
];

const beat = (key: string, chip: string, prompt: string) => ({ key, chip, prompt });

describe("syncTools secrets", () => {
  it("never relays a credential the vendo CLI echoed back", async () => {
    const demosRepo = await demoFolder();
    const key = "sk-ant-averylongfakekeyvalue";
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: `failed: ANTHROPIC_API_KEY=${key} rejected\n` });
    const error = await syncTools({ demosRepo, slug, exec, env: { ANTHROPIC_API_KEY: key } })
      .catch((thrown: unknown) => thrown as Error);
    expect(error.message).not.toContain(key);
    expect(error.message).toContain("<redacted>");
  });
});

describe("ungroundedBeats", () => {
  it("flags an authored pill that names a capability the demo does not have", () => {
    // The pill a prospect actually clicks. The beats agent wrote it before
    // tools.json existed, so this is the only check it ever gets.
    const beats = [
      beat("generate-ui", "Overdue invoices", "Show me every overdue invoice"),
      beat("take-action", "Flag shipment", "Flag shipment KF-4580 for review"),
    ];
    expect(ungroundedBeats(beats, shipmentTools).map((entry) => entry.key)).toEqual(["generate-ui"]);
  });

  it("exempts the two beats that exercise Vendo itself, not a host tool", () => {
    // Nothing in tools.json describes connecting Gmail or saving an app, so
    // demanding tool overlap here would reject a correct beat.
    const beats = [
      beat("connect-account", "Connect Gmail", "Connect my Gmail so you can read receipts"),
      beat("save-app", "Save as app", "Save this view as an app I can reopen"),
    ];
    expect(ungroundedBeats(beats, shipmentTools)).toEqual([]);
  });
});

describe("regroundBeats", () => {
  it("rewrites an ungrounded pill's wording but keeps its key and expectation flags", () => {
    const authored = [
      { ...beat("generate-ui", "Overdue invoices", "Show me every overdue invoice"), expectsView: true },
      { ...beat("take-action", "Flag it", "Flag shipment KF-4580 for review"), expectsApproval: true },
    ];
    const derived = [beat("lanes", "Shipments by lane", "Show me every shipment grouped by lane")];
    const result = regroundBeats(authored, shipmentTools, derived);
    expect(result.replaced).toEqual(["generate-ui"]);
    expect(result.stillUngrounded).toEqual([]);
    expect(result.beats[0]).toEqual({
      key: "generate-ui",
      chip: "Shipments by lane",
      prompt: "Show me every shipment grouped by lane",
      expectsView: true,
    });
    expect(result.beats[1]).toEqual(authored[1]);
  });

  it("reports a pill it cannot reground rather than shipping it silently", () => {
    const authored = [beat("generate-ui", "Overdue invoices", "Show me every overdue invoice")];
    expect(regroundBeats(authored, shipmentTools, []).stillUngrounded).toEqual(["generate-ui"]);
  });

  it("never regrounds a pill with a derived pill that is itself ungrounded", () => {
    const authored = [beat("generate-ui", "Overdue invoices", "Show me every overdue invoice")];
    const derived = [beat("junk", "Payroll runs", "Show me payroll runs")];
    const result = regroundBeats(authored, shipmentTools, derived);
    expect(result.replaced).toEqual([]);
    expect(result.stillUngrounded).toEqual(["generate-ui"]);
  });

  // The beat KIND is the contract; only the wording is the model's. Handing the
  // automation beat a one-off action pill kept the key — so beat-variety still
  // "passed" — and shipped a demo whose automation pill sets nothing up.
  it("refuses to reword the automation beat with a pill that is not recurring", () => {
    const authored = [beat("automation", "Weekly invoice digest", "Every Monday, send me the overdue invoices")];
    const oneOff = [beat("lanes", "Shipments by lane", "Show me every shipment grouped by lane")];
    const result = regroundBeats(authored, shipmentTools, oneOff);
    expect(result.replaced).toEqual([]);
    expect(result.stillUngrounded).toEqual(["automation"]);
    expect(result.beats[0]).toEqual(authored[0]);
  });

  it("does reword the automation beat with a recurring pill", () => {
    const authored = [beat("automation", "Weekly invoice digest", "Every Monday, send me the overdue invoices")];
    const recurring = [beat("weekly-lanes", "Weekly lane report", "Every Monday, summarise every shipment by lane")];
    const result = regroundBeats(authored, shipmentTools, recurring);
    expect(result.replaced).toEqual(["automation"]);
    expect(result.beats[0]?.prompt).toBe("Every Monday, summarise every shipment by lane");
  });

  // Merging appended the very pill regrounding had just consumed, so the same
  // sentence reached the strip twice under two keys.
  it("reports which derived pills it consumed, so merging cannot append them again", () => {
    const authored = [beat("generate-ui", "Overdue invoices", "Show me every overdue invoice")];
    const derived = [beat("lanes", "Shipments by lane", "Show me every shipment grouped by lane")];
    const result = regroundBeats(authored, shipmentTools, derived);
    expect(result.consumed.map((pill) => pill.key)).toEqual(["lanes"]);
  });
});

describe("buildAgentJobs", () => {
  it("is exactly three jobs — server+openapi, screens, demo.config.json — with disjoint writable roots", () => {
    const jobs = buildAgentJobs(jobOptions);
    expect(jobs.map((job) => job.name)).toEqual(["server", "screens", "beats"]);
    expect(jobs.map((job) => job.ownedRoots)).toEqual([
      ["server", "openapi.json"],
      ["screens"],
      ["demo.config.json"],
    ]);
    expect(() => assertDisjointOwnership(jobs)).not.toThrow();
  });

  // The host repo's README is the contract these prompts implement; a prompt
  // that drifts from it produces a demo that does not compile in the host.
  it("pins the host's real module contract in the server prompt", () => {
    const server = buildAgentJobs(jobOptions).find((job) => job.name === "server") as { prompt: string };
    // The store must be the host's keyed one: a module singleton is
    // instantiated once per route bundle in a production build, so an approved
    // mutation would not show on the page.
    expect(server.prompt).toContain('import { storeFor } from "@host/server/demo-store"');
    expect(server.prompt).toContain("export const getStore = () => storeFor(buildSeed)");
    expect(server.prompt).toContain('buildSeed(anchor: Date = new Date())');
    expect(server.prompt).toContain('import { mulberry32 } from "@host/prng"');
    expect(server.prompt).toContain('import type { DemoRoutes } from "@host/lib/demo-module"');
    // Captured :id segments arrive as search params, not a handler argument.
    expect(server.prompt).toContain('searchParams.get("id")');
    expect(server.prompt).toContain("server/store.ts");
  });

  // A live run died at the host build after ten minutes of generation because
  // the server agent exported `listLicenses` (from the stem) while the screens
  // agent imported `listVendorLicenses` (from the name). Both prompts must
  // carry the SAME identifiers.
  it("pins one identical domain API in both the server and screens prompts", () => {
    const jobs = buildAgentJobs(jobOptions);
    const server = jobs.find((job) => job.name === "server") as { prompt: string };
    const screens = jobs.find((job) => job.name === "screens") as { prompt: string };
    for (const api of domainApi(brief)) {
      expect(server.prompt).toContain(api.list);
      expect(screens.prompt).toContain(api.list);
      expect(server.prompt).toContain(api.get);
      expect(server.prompt).toContain(api.action);
    }
  });

  it("derives the list name from the plural stem, never from the PascalCase name", () => {
    // "Entry"/"entries" is the case that makes name-pluralisation wrong, and
    // "bank-transactions" is the case that makes it hyphenated.
    expect(domainApi({
      ...brief,
      entities: [
        { name: "Entry", stem: "entries", action: "voidEntry", fields: [], sampleRecordNames: [] },
        { name: "BankTransaction", stem: "bank-transactions", action: "syncTransaction", fields: [], sampleRecordNames: [] },
      ],
    })).toEqual([
      { name: "Entry", list: "listEntries", get: "getEntry", action: "voidEntry" },
      { name: "BankTransaction", list: "listBankTransactions", get: "getBankTransaction", action: "syncTransaction" },
    ]);
  });

  it("pins the kit's real export list in the screens prompt and forbids @vendoai/*", () => {
    const jobs = buildAgentJobs(jobOptions);
    const screens = jobs.find((job) => job.name === "screens") as { prompt: string };
    expect(screens.prompt).toContain("@host/vendo-kit");
    for (const surface of ["VendoTrigger", "VendoSlot", "VendoPage", "VendoThread", "VendoOverlay", "VendoActivities"]) {
      expect(screens.prompt).toContain(surface);
    }
    // The host mounts these around the page; a demo that mounts its own gets
    // two roots and an unthemed surface.
    expect(screens.prompt).toMatch(/VendoRoot[\s\S]*mounted by the HOST/);
    expect(screens.prompt).toContain("SERVER component");
    for (const job of jobs) expect(job.prompt).toContain("NEVER import from `@vendoai/*`");
  });

  it("tells every agent to paint with the host's themed Tailwind colours, never a hex", () => {
    for (const job of buildAgentJobs(jobOptions)) {
      expect(job.prompt).toContain("text-ink");
      expect(job.prompt).toContain("bg-accent");
      expect(job.prompt).toMatch(/[Nn]ever a hardcoded hex/);
    }
  });

  // Parallel agents editing the same file race, and the loser's work vanishes
  // silently. The split must fail LOUDLY rather than produce half a demo.
  it("refuses a split where two agents own overlapping roots", () => {
    const jobs = buildAgentJobs(jobOptions);
    const overlapping = [{ ...jobs[0]!, ownedRoots: ["server", "screens/index.tsx"] }, jobs[1]!];
    expect(() => assertDisjointOwnership(overlapping)).toThrow(/overlaps[\s\S]*redesign the split/);
  });

  it("fences host code and the already-written brand evidence in every prompt", () => {
    for (const job of buildAgentJobs(jobOptions)) {
      expect(job.prompt).toContain("host/");
      expect(job.prompt).toContain("theme.json");
      expect(job.prompt).toContain("BRIEF.md");
      // Evidence informs style, never data — the invariant every lane shares.
      expect(job.prompt).toMatch(/INVENTED/);
      expect(job.prompt).toMatch(/Foo\/Bar\/Lorem/);
      expect(job.prompt).toContain("YOUR FILE LIST");
    }
  });

  it("tells the screens agent to import Vendo surfaces from the host kit at the brief's placement", () => {
    const screens = buildAgentJobs(jobOptions).find((job) => job.name === "screens");
    expect(screens?.prompt).toContain("@host/vendo-kit");
    expect(screens?.prompt).toContain("VendoTrigger");
    expect(screens?.prompt).toContain(brief.placement.slot);
    expect(screens?.prompt).toContain(brief.referenceScreenshot);
  });

  // The lesson the last live run paid for: the beat names a seeded record, so
  // the record must seed in a state the mutation can still act on.
  it("tells the server agent to seed the brief's sample records in an actionable state", () => {
    const server = buildAgentJobs(jobOptions).find((job) => job.name === "server");
    expect(server?.prompt).toContain("INV-2041 Northwind Studio");
    expect(server?.prompt).toMatch(/still act on/i);
    expect(server?.prompt).toContain("voidInvoice");
  });

  // Worst case, not measured case: a live run measured $3.85, and the old caps
  // (6 + 8 + 2, plus a 2 repair) let a bad run spend $18 before anything
  // noticed. The ceiling is what bounds a runaway, so it is pinned here.
  it("keeps the whole build's worst-case spend under the pinned ceiling", () => {
    const jobs = buildAgentJobs(jobOptions);
    const fanOut = jobs.reduce((total, job) => total + job.maxBudgetUsd, 0);
    expect(fanOut + repairBudgetUsd).toBe(buildBudgetCeilingUsd);
    expect(buildBudgetCeilingUsd).toBeLessThanOrEqual(12);
    // …and every single agent still has real headroom over what a live run used.
    for (const job of jobs) expect(job.maxBudgetUsd).toBeGreaterThanOrEqual(1.5);
  });

  it("bounds every agent's wall clock too", () => {
    for (const job of buildAgentJobs(jobOptions)) {
      expect(job.timeoutMs).toBeLessThanOrEqual(20 * 60 * 1000);
    }
  });

  it("tells the beats agent the required arc and that it cannot see the tool surface yet", () => {
    const beats = buildAgentJobs(jobOptions).find((job) => job.name === "beats");
    for (const key of requiredBeatKeys) expect(beats?.prompt).toContain(key);
    expect(beats?.prompt).toMatch(/tools\.json does not exist yet/);
  });
});

describe("syncTools", () => {
  it("moves the synced tools.json to the demo root and removes the leftover .vendo/", async () => {
    const demosRepo = await demoFolder();
    const paths = demoPaths(demosRepo, slug);

    const count = await syncTools({
      demosRepo,
      slug,
      exec: fakeSync(["host_listInvoices", "host_voidInvoice"]),
    });

    expect(count).toBe(2);
    const written = JSON.parse(await readFile(paths.tools, "utf8")) as { tools: unknown[] };
    expect(written.tools).toHaveLength(2);
    // A stray .vendo/ would be committed into the host repo.
    expect(existsSync(path.join(paths.root, ".vendo"))).toBe(false);
  });

  it("runs the repo's own vendo CLI over the demo folder", async () => {
    const demosRepo = await demoFolder();
    const exec = vi.fn(fakeSync(["host_listInvoices"]));

    await syncTools({ demosRepo, slug, exec });

    const command = exec.mock.calls[0]![0];
    expect(command[0]).toBe("node");
    expect(command[1]).toMatch(/packages\/vendo\/bin\/vendo\.mjs$/);
    // `pnpm exec vendo` resolves to an unrelated deployment CLI on PATH, so the
    // pipeline points at this checkout's own bin — which must actually be there.
    expect(existsSync(command[1]!)).toBe(true);
    expect(command.slice(2)).toEqual(["sync", demoPaths(demosRepo, slug).root, "--no-watermark"]);
  });

  // A demo whose agent can do nothing is not shippable — better to fail the
  // pipeline than to ship a panel that refuses every pill.
  it("throws when the surface holds no product tools", async () => {
    const demosRepo = await demoFolder();
    await expect(syncTools({ demosRepo, slug, exec: fakeSync(["host_auth_create"]) }))
      .rejects.toThrow(/no product tools/);
  });

  it("names the failing sync command's output", async () => {
    const demosRepo = await demoFolder();
    const exec: ExecFn = async () => ({ code: 2, stdout: "", stderr: "openapi.json: unexpected token" });
    await expect(syncTools({ demosRepo, slug, exec })).rejects.toThrow(/vendo sync failed[\s\S]*unexpected token/);
  });
});

describe("runBuild", () => {
  const args = { slug, prospect: "Cadence", ctaUrl: "https://cal.com/yousefhelal", expiresAt: "2026-08-31T00:00:00Z", brief, theme };

  function io(overrides: {
    demosRepo: string;
    runAgent?: RunAgentFn;
    exec?: ExecFn;
    chipModel?: (prompt: string) => Promise<string>;
    lines?: string[];
  }) {
    return {
      demosRepo: overrides.demosRepo,
      runAgent: overrides.runAgent ?? (async (job) => agentOk(job.name)),
      exec: overrides.exec ?? fakeSync(["host_listInvoices", "host_voidInvoice"]),
      chipModel: overrides.chipModel ?? (async () => groundedChips),
      write: (line: string) => { overrides.lines?.push(line); },
      env: {} as NodeJS.ProcessEnv,
    };
  }

  it("runs the three agents in parallel, then syncs, grounds and writes a parsing config", async () => {
    const demosRepo = await demoFolder();
    const lines: string[] = [];
    const started: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const runAgent: RunAgentFn = async (job) => {
      started.push(job.name);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return agentOk(job.name);
    };

    const result = await runBuild(args, io({ demosRepo, runAgent, lines }));

    expect(started.sort()).toEqual(["beats", "screens", "server"]);
    expect(peak).toBe(3);
    expect(result.toolCount).toBe(2);
    expect(result.costUsd).toBeCloseTo(4.5);
    expect(result.beats.map((beat) => beat.key)).toEqual([...requiredBeatKeys]);

    const written = JSON.parse(await readFile(demoPaths(demosRepo, slug).config, "utf8")) as unknown;
    await expect(parseDemoFolderConfig(written)).resolves.toBeTruthy();
    // Operator facts are stamped, never left to the agent's invention.
    expect((written as { ctaUrl: string }).ctaUrl).toBe(args.ctaUrl);
    expect((written as { expiresAt: string }).expiresAt).toBe(args.expiresAt);
    expect(lines.join("\n")).toMatch(/agent server: exit 0/);
    expect(lines.join("\n")).toMatch(/grounding/);
  });

  it("names the failing agent and shows its output tail", async () => {
    const demosRepo = await demoFolder();
    const runAgent: RunAgentFn = async (job) =>
      job.name === "screens"
        ? { name: job.name, code: 1, output: "Write tool denied on screens/index.tsx", timedOut: false, permissionDenials: [] }
        : agentOk(job.name);

    await expect(runBuild(args, io({ demosRepo, runAgent })))
      .rejects.toThrow(/screens \(exit 1\)[\s\S]*Write tool denied/);
  });

  // `Promise.all` is fail-fast on the AWAIT only: the surviving agents kept
  // editing the same demo folder for up to twenty more minutes after the run had
  // already failed — including while an operator was looking at it.
  it("aborts the surviving agents the moment one fails", async () => {
    const demosRepo = await demoFolder();
    const aborted: string[] = [];
    const runAgent: RunAgentFn = async (job, options) => {
      if (job.name === "beats") {
        // Fails first, while the other two are still "running".
        return { name: job.name, code: 1, output: "budget exceeded", timedOut: false, permissionDenials: [] };
      }
      // A long agent that only ends when its signal is aborted.
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted === true) {
          aborted.push(job.name);
          resolve();
          return;
        }
        options.signal?.addEventListener("abort", () => { aborted.push(job.name); resolve(); }, { once: true });
      });
      return { name: job.name, code: 0, output: "cancelled", timedOut: false, permissionDenials: [] };
    };

    await expect(runBuild(args, io({ demosRepo, runAgent }))).rejects.toThrow(/beats \(exit 1\)/);
    expect(aborted.sort()).toEqual(["screens", "server"]);
  });

  // The rejected-spawn path unwinds with NO result at all, so the abort cannot
  // live only where a failing exit code is handled.
  it("aborts the surviving agents when one cannot be spawned at all", async () => {
    const demosRepo = await demoFolder();
    const aborted: string[] = [];
    const runAgent: RunAgentFn = async (job, options) => {
      if (job.name === "beats") throw new Error('Could not spawn the claude CLI for agent "beats": ENOENT');
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => { aborted.push(job.name); resolve(); }, { once: true });
      });
      return { name: job.name, code: 0, output: "cancelled", timedOut: false, permissionDenials: [] };
    };

    await expect(runBuild(args, io({ demosRepo, runAgent }))).rejects.toThrow(/Could not spawn/);
    expect(aborted.sort()).toEqual(["screens", "server"]);
  });

  it("surfaces a write the harness denied, so an escape attempt is visible", async () => {
    const demosRepo = await demoFolder();
    const lines: string[] = [];
    const runAgent: RunAgentFn = async (job) => ({
      ...agentOk(job.name),
      permissionDenials: job.name === "screens" ? ["Write /repo/host/src/vendo-kit/index.ts"] : [],
    });
    await runBuild(args, io({ demosRepo, runAgent, lines }));
    expect(lines.join("\n")).toMatch(/DENIED 1 write\(s\)[\s\S]*host\/src\/vendo-kit/);
  });

  it("drops a derived pill that cites a capability the demo does not have", async () => {
    const demosRepo = await demoFolder();
    const lines: string[] = [];
    const chipModel = async (): Promise<string> => chipReply([
      { key: "overdue", chip: "Overdue invoices", prompt: "Show me every overdue invoice", tools: ["host_listInvoices"] },
      { key: "reconcile", chip: "Reconcile bank feed", prompt: "Reconcile the bank feed", tools: ["host_reconcileBankFeed"] },
    ]);

    const result = await runBuild(args, io({ demosRepo, chipModel, lines }));

    expect(result.beats.map((beat) => beat.key)).not.toContain("reconcile");
    expect(lines.join("\n")).toMatch(/host_reconcileBankFeed/);
  });

  it("repairs a config missing a required beat kind with ONE targeted agent", async () => {
    const demosRepo = await demoFolder({ config: agentConfig(["generate-ui", "take-action", "save-app"]) });
    const paths = demoPaths(demosRepo, slug);
    const names: string[] = [];
    const runAgent: RunAgentFn = async (job) => {
      names.push(job.name);
      if (job.name.startsWith("beats-repair")) {
        expect(job.maxBudgetUsd).toBeLessThanOrEqual(2);
        expect(job.ownedRoots).toEqual(["demo.config.json"]);
        await writeFile(paths.config, `${JSON.stringify(agentConfig(), null, 2)}\n`);
      }
      return agentOk(job.name);
    };

    const result = await runBuild(args, io({ demosRepo, runAgent }));

    expect(names.filter((name) => name.startsWith("beats-repair"))).toHaveLength(1);
    expect(result.beats.map((beat) => beat.key)).toEqual([...requiredBeatKeys]);
  });

  it("gives up after one repair round, naming the beat kinds still missing", async () => {
    const demosRepo = await demoFolder({ config: agentConfig(["generate-ui", "take-action", "save-app"]) });
    const names: string[] = [];
    const runAgent: RunAgentFn = async (job) => {
      names.push(job.name);
      return agentOk(job.name);
    };

    await expect(runBuild(args, io({ demosRepo, runAgent })))
      .rejects.toThrow(/automation, connect-account/);
    expect(names.filter((name) => name.startsWith("beats-repair"))).toHaveLength(1);
  });

  // demo.config.json is overwritten twice — once with the known-invalid merged
  // state so the repair agent can SEE it, once with the final config — and both
  // were plain in-place writes. An I/O failure mid-write leaves truncated JSON,
  // which every later reader (the repair agent, demo:fix, the host build) then
  // fails to parse for a reason that has nothing to do with the demo.
  it("never leaves a partially written demo.config.json behind", async () => {
    const demosRepo = await demoFolder({ config: agentConfig(["generate-ui", "take-action", "save-app"]) });
    const paths = demoPaths(demosRepo, slug);
    const seen: string[] = [];
    const runAgent: RunAgentFn = async (job) => {
      if (job.name.startsWith("beats-repair")) {
        // Whatever the repair agent reads must be COMPLETE, parseable JSON.
        const onDisk = await readFile(paths.config, "utf8");
        seen.push(onDisk);
        JSON.parse(onDisk);
        await writeFile(paths.config, `${JSON.stringify(agentConfig(), null, 2)}\n`);
      }
      return agentOk(job.name);
    };

    await runBuild(args, io({ demosRepo, runAgent }));

    expect(seen).toHaveLength(1);
    // No temp file left in the demo folder — it would be committed to the host repo.
    const leftovers = (await readdir(paths.root)).filter((name) => name.includes("demo.config.json") && name !== "demo.config.json");
    expect(leftovers).toEqual([]);
    JSON.parse(await readFile(paths.config, "utf8"));
  });

  it("swaps the file in atomically and cleans up after itself", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-atomic-"));
    const target = path.join(dir, "demo.config.json");
    await writeFile(target, '{"old":true}\n');

    await writeJsonAtomic(target, { new: true });

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ new: true });
    // Nothing left over: a stray temp file inside the demo folder would be
    // committed into the host repo by ship's `git add -- demos/<slug>`.
    expect(await readdir(dir)).toEqual(["demo.config.json"]);
  });

  // The property that matters, raced for real: while a big config is being
  // written, every read of the destination must return COMPLETE JSON — the old
  // one or the new one. An in-place `writeFile` fails this, because it truncates
  // the destination first.
  it("never exposes a partial file to a concurrent reader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-atomic-"));
    const target = path.join(dir, "demo.config.json");
    const old = { generation: 0, filler: "x".repeat(2_000_000) };
    await writeFile(target, `${JSON.stringify(old, null, 2)}\n`);
    const next = { generation: 1, filler: "y".repeat(2_000_000) };

    const writing = writeJsonAtomic(target, next);
    const generations = new Set<number>();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      // Throws if the file is ever truncated or half-written.
      generations.add((JSON.parse(await readFile(target, "utf8")) as { generation: number }).generation);
    }
    await writing;
    generations.add((JSON.parse(await readFile(target, "utf8")) as { generation: number }).generation);

    expect([...generations].every((generation) => generation === 0 || generation === 1)).toBe(true);
  });

  it("keeps the old file when the new content cannot be written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vendo-atomic-"));
    const target = path.join(dir, "demo.config.json");
    await writeFile(target, '{"old":true}\n');
    // A value JSON.stringify refuses (a circular reference) stands in for any
    // failure between "start writing" and "finish writing".
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(writeJsonAtomic(target, circular)).rejects.toThrow();

    // The reader still sees the COMPLETE old file, not a truncated new one.
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual({ old: true });
    expect(await readdir(dir)).toEqual(["demo.config.json"]);
  });

  it("refuses to write a config the demo-folder schema would reject", async () => {
    const demosRepo = await demoFolder({ config: { ...agentConfig(), placement: { trigger: "footer", slot: "" } } });
    await expect(runBuild(args, io({ demosRepo }))).rejects.toThrow(/placement\.trigger/);
  });

  // Finding 4: the post-repair pass recomputed beat VARIETY only. Any pill an
  // ungrounded beat still carried therefore shipped — a repair round is
  // triggered by grounding failures too, so this was the common case, and the
  // checker shipped an ungrounded `automation` pill through it.
  it("re-checks grounding after the repair round, not just the beat arc", async () => {
    // Authored beats are all about invoices; the demo's real tools are shipments.
    const demosRepo = await demoFolder({ config: agentConfig() });
    const paths = demoPaths(demosRepo, slug);
    const runAgent: RunAgentFn = async (job) => {
      if (job.name.startsWith("beats-repair")) {
        // The repair agent "fixes" the arc while leaving the ungrounded wording.
        await writeFile(paths.config, `${JSON.stringify(agentConfig(), null, 2)}\n`);
      }
      return agentOk(job.name);
    };
    const exec = fakeSync(["host_listShipments", "host_flagShipment"]);

    // A derived pill that cites a real tool but says nothing about it is dropped,
    // so there is no replacement wording available — exactly the run where the
    // old post-repair pass had nothing to check grounding with.
    const chipModel = async (): Promise<string> => chipReply([
      { key: "payroll", chip: "Payroll runs", prompt: "Show me payroll runs", tools: ["host_listShipments"] },
    ]);

    await expect(runBuild(args, io({ demosRepo, runAgent, exec, chipModel })))
      .rejects.toThrow(/names no capability in tools\.json/);
  });

  // The shipped set is the invariant: unique keys, the five kinds, generate-ui
  // first, at most maxChips, every beat grounded.
  it("writes a beat set that satisfies the whole invariant", async () => {
    const demosRepo = await demoFolder();
    const result = await runBuild(args, io({ demosRepo }));
    expect(result.beats[0]?.key).toBe("generate-ui");
    expect(new Set(result.beats.map((beat) => beat.key)).size).toBe(result.beats.length);
    expect(result.beats.length).toBeLessThanOrEqual(maxChips);
    expect(result.beats.map((beat) => beat.key)).toEqual([...requiredBeatKeys]);
  });
});
