import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  VENDO_JUDGMENTS_FORMAT,
  VENDO_TOOLS_FORMAT,
  bindingIdentity,
  type ExtractedTool,
  type JudgmentsFile,
  type ToolJudgment,
} from "@vendoai/actions";
import type { ExtractionHarness } from "../extract/harness.js";
import { JUDGE_BATCH_LIMIT, runJudgmentPass, type JudgmentPassOptions } from "./pass.js";

const ESC = "\u001b";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const tool = (name: string, overrides: Partial<ExtractedTool> = {}): ExtractedTool => ({
  name,
  description: `Use this to call ${name}.`,
  inputSchema: { type: "object", properties: {} },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `/api/${name}`, argsIn: "query" },
  srcHash: `sha256:${name}`,
  ...overrides,
});

interface Fixture { root: string; out: string; toolsPath: string; judgmentsPath: string }

async function host(tools: ExtractedTool[], judgments?: Record<string, ToolJudgment>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "vendo-judge-pass-"));
  temporary.push(root);
  const out = join(root, ".vendo");
  await mkdir(out, { recursive: true });
  const toolsPath = join(out, "tools.json");
  await writeFile(toolsPath, `${JSON.stringify({ format: VENDO_TOOLS_FORMAT, tools }, null, 2)}\n`, "utf8");
  const judgmentsPath = join(out, "judgments.json");
  if (judgments !== undefined) {
    await writeFile(
      judgmentsPath,
      `${JSON.stringify({ format: VENDO_JUDGMENTS_FORMAT, tools: judgments }, null, 2)}\n`,
      "utf8",
    );
  }
  return { root, out, toolsPath, judgmentsPath };
}

const readJudgments = async (fixture: Fixture): Promise<JudgmentsFile> =>
  JSON.parse(await readFile(fixture.judgmentsPath, "utf8")) as JudgmentsFile;

function channel(): { output: { log: (m: string) => void; error: (m: string) => void }; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { output: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

const reply = (value: unknown): string => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** Fake harness: canned replies handed out in order, and every prompt recorded
 *  so a test can prove which stage asked what. */
function scripted(responses: string[]): ExtractionHarness & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "scripted",
    prompts,
    availability: async () => "scripted engine",
    async run(input) {
      prompts.push(input.instructions);
      const next = responses.shift();
      if (next === undefined) throw new Error("scripted harness exhausted");
      return next;
    },
  };
}

/** Any invocation at all — even the availability probe — fails the test. */
const forbidden: ExtractionHarness = {
  id: "forbidden",
  availability: async () => { throw new Error("a keyless pass must never probe an engine"); },
  run: async () => { throw new Error("a keyless pass must never invoke a model"); },
};

function options(
  fixture: Fixture,
  bus: ReturnType<typeof channel>,
  partial: Partial<JudgmentPassOptions> = {},
): JudgmentPassOptions {
  return {
    root: fixture.root,
    out: fixture.out,
    mode: "full",
    loosenings: "queue",
    env: {},
    output: bus.output,
    appName: "acme-app",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Candidate math
// ---------------------------------------------------------------------------

describe("runJudgmentPass — candidates", () => {
  it("full mode judges EVERY tool, enabled or disabled", async () => {
    const fixture = await host([tool("host_a"), tool("host_b", { disabled: true })]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [
        { name: "host_a", description: "Reads a.", evidence: "select().from(a)" },
        { name: "host_b", description: "Reads b.", evidence: "select().from(b)" },
      ], narrative: "read both" }),
      reply({ verdicts: [
        { name: "host_a", field: "description", verdict: "uphold" },
        { name: "host_b", field: "description", verdict: "uphold" },
      ] }),
    ]);
    const result = await runJudgmentPass(options(fixture, bus, { harness }));
    expect(result.status).toBe("judged");
    const file = await readJudgments(fixture);
    expect(Object.keys(file.tools).sort()).toEqual(["host_a", "host_b"]);
  });

  it("incremental mode says `up to date` with NO model touchpoint when every judgment is fresh", async () => {
    const one = tool("host_a");
    const fixture = await host([one], {
      host_a: {
        binding: bindingIdentity(one.binding),
        srcHash: one.srcHash,
        fields: { description: "Reads a." },
        evidence: "select().from(a)",
      },
    });
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      mode: "incremental",
      harnesses: [forbidden],
      resolveCredential: async () => { throw new Error("the up-to-date check must run BEFORE engine resolution"); },
    }));
    expect(result.status).toBe("up-to-date");
    expect(bus.logs.join("\n")).toContain("judgment: up to date");
  });

  it("incremental mode re-judges on srcHash drift, binding mismatch, and never-judged", async () => {
    const drifted = tool("host_drift", { srcHash: "sha256:NEW" });
    const rebound = tool("host_rebound");
    const fresh = tool("host_fresh");
    const untouched = tool("host_untouched");
    const fixture = await host([drifted, rebound, fresh, untouched], {
      host_drift: {
        binding: bindingIdentity(drifted.binding),
        srcHash: "sha256:OLD",
        fields: { description: "stale" },
        evidence: "old quote",
      },
      host_rebound: {
        binding: "GET /api/somewhere-else",
        srcHash: rebound.srcHash,
        fields: { description: "inert" },
        evidence: "old quote",
      },
      host_untouched: {
        binding: bindingIdentity(untouched.binding),
        srcHash: untouched.srcHash,
        fields: { description: "current" },
        evidence: "good quote",
      },
    });
    const bus = channel();
    const harness = scripted([
      reply({ tools: [], narrative: "nothing" }),
    ]);
    await runJudgmentPass(options(fixture, bus, { mode: "incremental", harness }));
    // The judge prompt is the proof of the candidate set.
    const prompt = harness.prompts[0]!;
    expect(prompt).toContain("host_drift");
    expect(prompt).toContain("host_rebound");
    expect(prompt).toContain("host_fresh");
    expect(prompt).not.toContain("host_untouched");
  });

  it("chunks candidates at JUDGE_BATCH_LIMIT, sorted by binding identity", async () => {
    expect(JUDGE_BATCH_LIMIT).toBe(20);
    const tools = Array.from({ length: 21 }, (_, index) => tool(`host_${String(index).padStart(2, "0")}`));
    const fixture = await host(tools);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [], narrative: "" }),
      reply({ tools: [], narrative: "" }),
    ]);
    await runJudgmentPass(options(fixture, bus, { harness }));
    expect(harness.prompts).toHaveLength(2);
    // Sorted by bindingIdentity ("GET /api/host_00" … "GET /api/host_20").
    expect(harness.prompts[0]).toContain("host_00");
    expect(harness.prompts[0]).not.toContain("host_20");
    expect(harness.prompts[1]).toContain("host_20");
    // The coverage question rides the LAST chunk only.
    expect(harness.prompts[0]).not.toContain("missedSurfaces");
    expect(harness.prompts[1]).toContain("missedSurfaces");
  });
});

// ---------------------------------------------------------------------------
// Evidence + the skeptic
// ---------------------------------------------------------------------------

describe("runJudgmentPass — evidence and the skeptic", () => {
  it("rejects an evidence-less proposal at parse and counts it honestly", async () => {
    const fixture = await host([tool("host_a"), tool("host_b")]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [
        { name: "host_a", risk: "destructive" },
        { name: "host_b", risk: "destructive", evidence: "await db.delete(b)" },
      ], narrative: "" }),
      reply({ verdicts: [{ name: "host_b", field: "risk", verdict: "uphold" }] }),
    ]);
    const result = await runJudgmentPass(options(fixture, bus, { harness }));
    expect(result).toMatchObject({ status: "judged", evidenceless: 1 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a).toBeUndefined();
    expect(file.tools.host_b!.fields.risk).toBe("destructive");
    expect(bus.logs.join("\n")).toMatch(/1 .*no evidence|no evidence.*1/i);
  });

  it("a skeptic reject drops a HARDENING, not just a loosening", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [{
        name: "host_a",
        risk: "destructive",
        confirmEach: true,
        evidence: "await db.delete(a)",
      }], narrative: "" }),
      reply({ verdicts: [
        { name: "host_a", field: "risk", verdict: "reject", reason: "the handler only selects" },
        { name: "host_a", field: "confirmEach", verdict: "uphold" },
      ] }),
    ]);
    const result = await runJudgmentPass(options(fixture, bus, { harness }));
    expect(result).toMatchObject({ status: "judged", rejectedBySkeptic: 1 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a!.fields.risk).toBeUndefined();
    expect(file.tools.host_a!.fields.confirmEach).toBe(true);
  });

  it("a fully rejected proposal writes NO entry, so the tool stays a candidate", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [{ name: "host_a", risk: "destructive", evidence: "invented quote" }], narrative: "" }),
      reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "reject", reason: "quote is not in the file" }] }),
    ]);
    await runJudgmentPass(options(fixture, bus, { harness }));
    // Nothing survived, so nothing is recorded at all — not even an empty file
    // whose srcHash would stop the tool being re-judged next run.
    await expect(readFile(fixture.judgmentsPath, "utf8")).rejects.toThrow();
    expect(bus.logs.join("\n")).toMatch(/wholly rejected|left unjudged/i);
  });

  it("an unexamined field gets ONE re-ask, then fails closed with an honest count", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [{
        name: "host_a",
        risk: "destructive",
        confirmEach: true,
        evidence: "await db.delete(a)",
      }], narrative: "" }),
      // First skeptic look: only `risk` gets a verdict.
      reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "uphold" }] }),
      // The single re-ask still ignores `confirmEach`.
      reply({ verdicts: [] }),
    ]);
    const result = await runJudgmentPass(options(fixture, bus, { harness }));
    expect(harness.prompts).toHaveLength(3);
    expect(harness.prompts[2]).toMatch(/re-ask|FINAL/i);
    expect(result).toMatchObject({ status: "judged", unexaminedRejected: 1 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a!.fields.risk).toBe("destructive");
    expect(file.tools.host_a!.fields.confirmEach).toBeUndefined();
    expect(bus.logs.join("\n")).toMatch(/unexamined/i);
  });

  it("a re-ask that answers is honored", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [{ name: "host_a", risk: "destructive", confirmEach: true, evidence: "await db.delete(a)" }], narrative: "" }),
      reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "uphold" }] }),
      reply({ verdicts: [{ name: "host_a", field: "confirmEach", verdict: "uphold" }] }),
    ]);
    const result = await runJudgmentPass(options(fixture, bus, { harness }));
    expect(result).toMatchObject({ unexaminedRejected: 0 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a!.fields.confirmEach).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("runJudgmentPass — routing", () => {
  it("hardenings and prose land in `fields`; loosenings land in `pending`", async () => {
    const fixture = await host([
      tool("host_harden", { risk: "read" }),
      tool("host_loosen", { risk: "destructive", confirmEach: true, disabled: true, audience: "internal" }),
    ]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [
        {
          name: "host_harden",
          description: "Deletes everything.",
          title: "Delete everything",
          risk: "destructive",
          confirmEach: true,
          disabled: true,
          audience: "internal",
          evidence: "await db.delete(all)",
        },
        {
          name: "host_loosen",
          risk: "read",
          confirmEach: false,
          disabled: false,
          audience: "end-user",
          evidence: "requireUser(session); return db.select()",
        },
      ], narrative: "" }),
      reply({ verdicts: [
        { name: "host_harden", field: "description", verdict: "uphold" },
        { name: "host_harden", field: "title", verdict: "uphold" },
        { name: "host_harden", field: "risk", verdict: "uphold" },
        { name: "host_harden", field: "confirmEach", verdict: "uphold" },
        { name: "host_harden", field: "disabled", verdict: "uphold" },
        { name: "host_harden", field: "audience", verdict: "uphold" },
        { name: "host_loosen", field: "risk", verdict: "uphold" },
        { name: "host_loosen", field: "confirmEach", verdict: "uphold" },
        { name: "host_loosen", field: "disabled", verdict: "uphold" },
        { name: "host_loosen", field: "audience", verdict: "uphold" },
      ] }),
    ]);
    await runJudgmentPass(options(fixture, bus, { harness }));
    const file = await readJudgments(fixture);

    const hardened = file.tools.host_harden!;
    expect(hardened.fields).toMatchObject({
      description: "Deletes everything.",
      title: "Delete everything",
      risk: "destructive",
      confirmEach: true,
      disabled: true,
      audience: "internal",
    });
    expect(hardened.pending ?? []).toEqual([]);
    expect(hardened.binding).toBe("GET /api/host_harden");
    expect(hardened.srcHash).toBe("sha256:host_harden");
    expect(hardened.evidence).toBe("await db.delete(all)");

    const loosened = file.tools.host_loosen!;
    // NOTHING loosening reached `fields`.
    expect(loosened.fields.risk).toBeUndefined();
    expect(loosened.fields.confirmEach).toBeUndefined();
    expect(loosened.fields.disabled).toBeUndefined();
    expect(loosened.fields.audience).toBeUndefined();
    expect((loosened.pending ?? []).map((entry) => entry.field).sort())
      .toEqual(["audience", "confirmEach", "disabled", "risk"]);
    for (const entry of loosened.pending ?? []) {
      expect(entry.evidence).toBe("requireUser(session); return db.select()");
    }
  });

  it("queue mode appends to `pending` and NEVER applies, printing the review pointer", async () => {
    const fixture = await host([tool("host_a", { risk: "destructive" })]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [{ name: "host_a", risk: "read", evidence: "return db.select()" }], narrative: "" }),
      reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "uphold" }] }),
    ]);
    const result = await runJudgmentPass(options(fixture, bus, {
      harness,
      loosenings: "queue",
      confirm: async () => { throw new Error("queue mode must never prompt"); },
    }));
    expect(result).toMatchObject({ queued: 1, approved: 0 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a!.fields.risk).toBeUndefined();
    expect(file.tools.host_a!.pending).toHaveLength(1);
    expect(bus.logs.join("\n")).toContain("vendo sync --review");
  });

  it("prunes judgments whose tool vanished or was rebound", async () => {
    const kept = tool("host_kept");
    const rebound = tool("host_rebound");
    const fixture = await host([kept, rebound], {
      host_kept: {
        binding: bindingIdentity(kept.binding),
        srcHash: kept.srcHash,
        fields: { description: "Reads kept." },
        evidence: "quote",
      },
      host_gone: {
        binding: "GET /api/host_gone",
        fields: { description: "Reads a tool that no longer exists." },
        evidence: "quote",
      },
      host_rebound: {
        binding: "POST /api/moved",
        fields: { risk: "destructive" },
        evidence: "quote",
      },
    });
    const bus = channel();
    const harness = scripted([reply({ tools: [], narrative: "" })]);
    await runJudgmentPass(options(fixture, bus, { harness, mode: "incremental" }));
    const file = await readJudgments(fixture);
    expect(Object.keys(file.tools)).toEqual(["host_kept"]);
  });
});

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

describe("runJudgmentPass — review mode", () => {
  const looseningRun = (): string[] => [
    reply({ tools: [{ name: "host_a", risk: "read", evidence: "return db.select()" }], narrative: "" }),
    reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "uphold" }] }),
  ];

  it("approve moves the loosening out of `pending` and into `fields`", async () => {
    const fixture = await host([tool("host_a", { risk: "destructive" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted(looseningRun()),
      loosenings: "review",
      confirm: async () => true,
    }));
    expect(result).toMatchObject({ approved: 1, queued: 0 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a!.fields.risk).toBe("read");
    expect(file.tools.host_a!.pending ?? []).toEqual([]);
  });

  it("decline drops the loosening entirely — it is not silently queued", async () => {
    const fixture = await host([tool("host_a", { risk: "destructive" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted(looseningRun()),
      loosenings: "review",
      confirm: async () => false,
    }));
    expect(result).toMatchObject({ approved: 0 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a?.fields.risk).toBeUndefined();
    expect(file.tools.host_a?.pending ?? []).toEqual([]);
  });

  it("aggregates ALREADY-pending loosenings into the same one diff", async () => {
    const one = tool("host_a", { risk: "destructive", disabled: true });
    const fixture = await host([one], {
      host_a: {
        binding: bindingIdentity(one.binding),
        fields: {},
        evidence: "earlier quote",
        pending: [{ field: "disabled", value: false, evidence: "requireUser(session)" }],
      },
    });
    const bus = channel();
    const questions: string[] = [];
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted(looseningRun()),
      loosenings: "review",
      confirm: async (question) => { questions.push(question); return true; },
    }));
    // ONE question covering both the new risk lowering and the standing wake-up.
    expect(questions).toHaveLength(1);
    expect(result).toMatchObject({ approved: 2 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_a!.fields.risk).toBe("read");
    expect(file.tools.host_a!.fields.disabled).toBe(false);
    expect(file.tools.host_a!.pending ?? []).toEqual([]);
  });

  it("SANITIZES control characters out of the evidence shown in the review diff", async () => {
    const fixture = await host([tool("host_a", { risk: "destructive" })]);
    const bus = channel();
    await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{
          name: "host_a",
          risk: "read",
          evidence: `return db.select()${ESC}[2K spoofed`,
          reason: `only reads${ESC}[31m`,
        }], narrative: `narrative${ESC}[0m` }),
        reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "uphold" }] }),
      ]),
      loosenings: "review",
      confirm: async () => false,
    }));
    const printed = [...bus.logs, ...bus.errors].join("\n");
    expect(printed).toContain("risk: destructive → read");
    expect(printed).not.toContain(ESC);
  });
});

// ---------------------------------------------------------------------------
// Degradation + artifacts
// ---------------------------------------------------------------------------

describe("runJudgmentPass — degradation and artifacts", () => {
  it("keyless: ONE calm line, zero errors, judgments.json untouched, no model touchpoint", async () => {
    const fixture = await host([tool("host_a"), tool("host_b")]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      resolveCredential: async () => ({ rung: "none" }),
      harnesses: [forbidden],
    }));
    expect(result).toEqual({ status: "structural-only", unjudged: 2 });
    expect(bus.logs.join("\n")).toContain("judgment: structural-only");
    expect(bus.logs.join("\n")).toContain("2 tools unjudged");
    expect(bus.errors).toEqual([]);
    await expect(readFile(fixture.judgmentsPath, "utf8")).rejects.toThrow();
  });

  it("writes a stage artifact per judge and skeptic run", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const harness = scripted([
      reply({ tools: [{ name: "host_a", risk: "destructive", evidence: "await db.delete(a)" }], narrative: "" }),
      reply({ verdicts: [{ name: "host_a", field: "risk", verdict: "uphold" }] }),
    ]);
    await runJudgmentPass(options(fixture, bus, { harness }));
    const artifacts = await readdir(join(fixture.out, "data", "judge"));
    expect(artifacts.sort()).toEqual(["judge-1.json", "skeptic-1.json"]);
    const judged = JSON.parse(await readFile(join(fixture.out, "data", "judge", "judge-1.json"), "utf8")) as {
      tools: Array<{ name: string }>;
    };
    expect(judged.tools[0]!.name).toBe("host_a");
  });

  it("unparseable judge output degrades: a warning, no write, and the structural files stand", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted(["I could not read the repo, sorry."]),
    }));
    expect(result.status).toBe("skipped");
    expect(bus.errors.join("\n")).toMatch(/warning/i);
    await expect(readFile(fixture.judgmentsPath, "utf8")).rejects.toThrow();
  });

  it("surfaces missedSurfaces as WARNINGS only — never as tools", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const harness = scripted([
      reply({
        tools: [{ name: "host_a", description: "Reads a.", evidence: "select().from(a)" }],
        missedSurfaces: ["src/graphql/* — no tools extracted"],
        narrative: "",
      }),
      reply({ verdicts: [{ name: "host_a", field: "description", verdict: "uphold" }] }),
    ]);
    await runJudgmentPass(options(fixture, bus, { harness }));
    const file = await readJudgments(fixture);
    expect(Object.keys(file.tools)).toEqual(["host_a"]);
    expect([...bus.logs, ...bus.errors].join("\n")).toContain("src/graphql/*");
  });

  it("a malformed judgments.json fails LOUDLY — a file that can carry disables is never ignored", async () => {
    const fixture = await host([tool("host_a")]);
    await writeFile(fixture.judgmentsPath, `{ "format": "vendo/judgments@1", "tools": { "host_a": {} } }`, "utf8");
    const bus = channel();
    await expect(runJudgmentPass(options(fixture, bus, { harness: scripted([]) }))).rejects.toThrow();
  });

  it("rewrites judgments.json with stable key order and no churn when nothing changed", async () => {
    const one = tool("host_a");
    const two = tool("host_b");
    const fixture = await host([two, one], {
      host_b: { binding: bindingIdentity(two.binding), srcHash: two.srcHash, fields: { description: "b" }, evidence: "q" },
      host_a: { binding: bindingIdentity(one.binding), srcHash: one.srcHash, fields: { description: "a" }, evidence: "q" },
    });
    const before = await readFile(fixture.judgmentsPath, "utf8");
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      mode: "incremental",
      harnesses: [forbidden],
      resolveCredential: async () => ({ rung: "none" }),
    }));
    expect(result.status).toBe("up-to-date");
    // Up-to-date returns before any write: byte-identical, mtime untouched.
    expect(await readFile(fixture.judgmentsPath, "utf8")).toBe(before);

    // A pass that DOES run writes sorted keys.
    const fresh = await host([two, one]);
    const harness = scripted([
      reply({ tools: [
        { name: "host_b", description: "Reads b.", evidence: "select().from(b)" },
        { name: "host_a", description: "Reads a.", evidence: "select().from(a)" },
      ], narrative: "" }),
      reply({ verdicts: [
        { name: "host_a", field: "description", verdict: "uphold" },
        { name: "host_b", field: "description", verdict: "uphold" },
      ] }),
    ]);
    await runJudgmentPass(options(fresh, channel(), { harness }));
    const written = await readFile(fresh.judgmentsPath, "utf8");
    expect(written.indexOf('"host_a"')).toBeLessThan(written.indexOf('"host_b"'));
  });
});

// ---------------------------------------------------------------------------
// Batch resilience: an ADVISORY field must never be able to kill judgments.
// Lane D's P6 — on openstatus, two `missedSurfaces` strings 37 and 11 chars
// over the limit discarded 9 valid evidence-backed proposals, because the
// advisory and the proposals shared one all-or-nothing envelope parse.
// ---------------------------------------------------------------------------

describe("runJudgmentPass — advisories can never discard proposals", () => {
  /** Two tools, both with real evidence — the judgments that must survive. */
  const twoGoodProposals = [
    { name: "host_transferMoney", risk: "destructive" as const, evidence: "await ledger.transfer(from, to, amountCents)" },
    { name: "host_createOrder", confirmEach: true as const, evidence: "await db.insert(orders).values(row)" },
  ];
  const upholdBoth = {
    verdicts: [
      { name: "host_transferMoney", field: "risk", verdict: "uphold" },
      { name: "host_createOrder", field: "confirmEach", verdict: "uphold" },
    ],
  };

  const twoToolHost = async (): Promise<Fixture> => host([
    tool("host_transferMoney", { risk: "read" }),
    tool("host_createOrder"),
  ]);

  it("an over-long missedSurfaces string does NOT discard the batch's proposals", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    // 337 and 311 chars — the exact shape of the openstatus failure.
    const over = `src/app/api/${"x".repeat(324)}`;
    expect(over.length).toBeGreaterThan(300);
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: twoGoodProposals, missedSurfaces: [over, `src/trpc/${"y".repeat(302)}`], narrative: "read both" }),
        reply(upholdBoth),
      ]),
    }));

    expect(result.status).toBe("judged");
    const file = await readJudgments(fixture);
    expect(file.tools.host_transferMoney!.fields.risk).toBe("destructive");
    expect(file.tools.host_createOrder!.fields.confirmEach).toBe(true);
    // Counted honestly, not swallowed.
    expect(result).toMatchObject({ advisoriesClamped: 2 });
    const printed = [...bus.logs, ...bus.errors].join("\n");
    expect(printed).toMatch(/advisor/i);
    // The lead itself survives, truncated — a cut lead still names the surface.
    expect(printed).toContain("src/app/api/");
  });

  it("an over-long narrative does NOT discard the batch's proposals", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: twoGoodProposals, narrative: "n".repeat(4500) }),
        reply(upholdBoth),
      ]),
    }));
    expect(result.status).toBe("judged");
    const file = await readJudgments(fixture);
    expect(file.tools.host_transferMoney!.fields.risk).toBe("destructive");
    expect(result).toMatchObject({ advisoriesClamped: 1 });
  });

  it("structurally unusable advisories (wrong types) do NOT discard proposals", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({
          tools: twoGoodProposals,
          missedSurfaces: { nope: "an object where an array belongs" },
          narrative: { also: "not a string" },
        }),
        reply(upholdBoth),
      ]),
    }));
    expect(result.status).toBe("judged");
    const file = await readJudgments(fixture);
    expect(file.tools.host_transferMoney!.fields.risk).toBe("destructive");
    expect(file.tools.host_createOrder!.fields.confirmEach).toBe(true);
    expect(result.status === "judged" && result.advisoriesClamped > 0).toBe(true);
  });

  it("non-string items inside missedSurfaces are dropped, the string ones survive", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: twoGoodProposals, missedSurfaces: ["src/graphql/* — no tools", 42, null], narrative: "" }),
        reply(upholdBoth),
      ]),
    }));
    expect(result.status).toBe("judged");
    expect([...bus.logs, ...bus.errors].join("\n")).toContain("src/graphql/*");
    expect(result).toMatchObject({ advisoriesClamped: 2 });
  });

  it("an over-long `reason` clamps instead of discarding that tool's judgment", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({
          tools: [
            { ...twoGoodProposals[0]!, reason: "r".repeat(600) },
            twoGoodProposals[1]!,
          ],
          narrative: "",
        }),
        reply(upholdBoth),
      ]),
    }));
    expect(result.status).toBe("judged");
    // The proposal survived: an explanatory string cannot cost a capability grade.
    const file = await readJudgments(fixture);
    expect(file.tools.host_transferMoney!.fields.risk).toBe("destructive");
    expect(result).toMatchObject({ evidenceless: 0 });
  });

  it("over-long prose (description/title) clamps instead of discarding the proposal", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({
          tools: [{
            name: "host_createOrder",
            description: "d".repeat(900),
            title: "t".repeat(140),
            evidence: "await db.insert(orders).values(row)",
          }],
          narrative: "",
        }),
        reply({ verdicts: [
          { name: "host_createOrder", field: "description", verdict: "uphold" },
          { name: "host_createOrder", field: "title", verdict: "uphold" },
        ] }),
      ]),
    }));
    const file = await readJudgments(fixture);
    const fields = file.tools.host_createOrder!.fields;
    // Clamped to the bounds Lane A's judgmentFieldsSchema enforces, not dropped.
    expect(fields.description!.length).toBeLessThanOrEqual(500);
    expect(fields.title!.length).toBeLessThanOrEqual(60);
  });

  it("an over-long `evidence` quote clamps too — it is evidence, not the absence of it", async () => {
    // The most thorough possible answer (a long quoted handler body) failed the
    // 500-char bound, and every issue on the evidence path is bucketed as
    // "evidence-less" — so the operator was told the model supplied no evidence
    // and the whole grade was silently dropped.
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({
          tools: [{ ...twoGoodProposals[0]!, evidence: `await db.update(accounts)${"x".repeat(600)}` }],
          narrative: "",
        }),
        reply({ verdicts: [{ name: twoGoodProposals[0]!.name, field: "risk", verdict: "uphold" }] }),
      ]),
    }));

    expect(result).toMatchObject({ status: "judged", evidenceless: 0 });
    const file = await readJudgments(fixture);
    expect(file.tools.host_transferMoney!.fields.risk).toBe("destructive");
  });

  it("a capability field with a BOGUS value is still rejected — clamping is prose-only", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{ name: "host_createOrder", risk: "catastrophic", evidence: "await db.insert(orders)" }], narrative: "" }),
      ]),
    }));
    // An invented enum is a real error: rejected, counted, nothing written.
    expect(result).toMatchObject({ status: "judged", judged: 0 });
    expect([...bus.logs, ...bus.errors].join("\n")).toMatch(/malformed/i);
  });

  it("evidence-less proposals are STILL rejected — tolerance never reaches evidence", async () => {
    const fixture = await twoToolHost();
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{ name: "host_createOrder", risk: "destructive" }], missedSurfaces: ["z".repeat(400)], narrative: "" }),
      ]),
    }));
    expect(result).toMatchObject({ status: "judged", evidenceless: 1, judged: 0 });
  });
});

// ---------------------------------------------------------------------------
// Terminal-spoofing: a NAME is model-authored text like any other. Codex's
// adversarial pass (finding 2) caught the rejected/evidence-less name paths
// printing raw model output straight to the operator's terminal.
// ---------------------------------------------------------------------------

describe("runJudgmentPass — model-authored names cannot spoof the terminal", () => {
  const BEL = String.fromCharCode(7);
  const CSI = String.fromCharCode(0x9b);
  /** An xterm window-title escape: the classic "rewrite what the human reads". */
  const OSC_TITLE = `${ESC}]0;pwned${BEL}`;

  it("strips control characters from an EVIDENCE-LESS proposal's name", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        // No evidence at all -> the name lands in the evidence-less narrative.
        reply({ tools: [{ name: `${OSC_TITLE}host_x`, risk: "destructive" }], narrative: "" }),
      ]),
    }));
    expect(result).toMatchObject({ evidenceless: 1 });
    const printed = [...bus.logs, ...bus.errors].join("\n");
    expect(printed).toContain("no evidence");
    // The visible characters survive so the operator still sees WHAT was
    // rejected; the control bytes do not.
    expect(printed).toContain("host_x");
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(BEL);
  });

  it("strips control characters from a MALFORMED proposal's name", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        // Has evidence, but an invented enum -> the malformed narrative.
        reply({ tools: [{ name: `${ESC}[31mhost_y`, evidence: "q", risk: "catastrophic" }], narrative: "" }),
      ]),
    }));
    expect(result).toMatchObject({ status: "judged" });
    const printed = [...bus.logs, ...bus.errors].join("\n");
    expect(printed).toContain("malformed");
    expect(printed).toContain("host_y");
    expect(printed).not.toContain(ESC);
  });

  it("strips control characters from an UNKNOWN tool's name", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{ name: `${OSC_TITLE}host_not_in_catalog`, evidence: "q" }], narrative: "" }),
      ]),
    }));
    const printed = [...bus.logs, ...bus.errors].join("\n");
    expect(printed).toContain("unknown tools");
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(BEL);
  });

  it("NOTHING the model authored reaches the terminal with control bytes — every channel at once", async () => {
    const fixture = await host([tool("host_a", { risk: "destructive" })]);
    const bus = channel();
    await runJudgmentPass(options(fixture, bus, {
      loosenings: "queue",
      harness: scripted([
        reply({
          tools: [
            // a real, applying proposal whose every prose field is hostile
            {
              name: "host_a",
              description: `Reads${ESC}[2K rows`,
              title: `List${CSI}x`,
              risk: "read",
              evidence: `db.select()${ESC}[31m`,
              reason: `only reads${ESC}[0m`,
            },
            // an evidence-less one with a hostile name
            { name: `${OSC_TITLE}host_evil`, risk: "destructive" },
          ],
          missedSurfaces: [`src/api/${ESC}[2Kspoof`],
          narrative: `all done${OSC_TITLE}`,
        }),
        reply({ verdicts: [
          { name: "host_a", field: "description", verdict: "uphold" },
          { name: "host_a", field: "title", verdict: "uphold" },
          { name: "host_a", field: "risk", verdict: "reject", reason: `nope${ESC}[5m` },
        ] }),
      ]),
    }));
    const printed = [...bus.logs, ...bus.errors].join("\n");
    // Every line the operator sees, across BOTH channels, is escape-free.
    expect(printed).not.toContain(ESC);
    expect(printed).not.toContain(BEL);
    expect(printed).not.toContain(CSI);
    // ...and the narrative is still informative, not blanked out.
    expect(printed).toContain("host_evil");
    expect(printed).toContain("rejected by the skeptic");
  });
});

// ---------------------------------------------------------------------------
// BUG 1 (live corpus diagnostic): a syntax slip two characters from the end of
// otherwise-perfect output destroyed whole batches, because parseArtifact calls
// bare JSON.parse on the fenced block.
// ---------------------------------------------------------------------------

describe("runJudgmentPass — a malformed batch is repaired, never discarded", () => {
  const fence = (body: string): string => `Here is my judgment.\n\n\`\`\`json\n${body}\n\`\`\`\n`;
  const grade = (index: number): string =>
    `    { "name": "host_tool_${index}", "risk": "read", "evidence": "return await db.select().from(t${index})",`
    + ` "reason": "plain authenticated read" }`;

  it("recovers all 20 rallly grades from a TRAILING COMMA after the narrative", async () => {
    // 20 tools graded destructive by the scanner; the model correctly downgrades
    // every one. Before the fix all 20 were lost to the stray comma.
    const tools = Array.from({ length: 20 }, (_, i) => tool(`host_tool_${i}`, { risk: "destructive" }));
    const fixture = await host(tools);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      loosenings: "queue",
      harness: scripted([
        fence(
          `{\n  "tools": [\n${Array.from({ length: 20 }, (_, i) => grade(i)).join(",\n")}\n  ],\n`
          + `  "narrative": "Five are plain authenticated reads mislabeled destructive.",\n}`,
        ),
        reply({
          verdicts: Array.from({ length: 20 }, (_, i) => ({
            name: `host_tool_${i}`, field: "risk", verdict: "uphold",
          })),
        }),
      ]),
    }));

    expect(result.status).toBe("judged");
    // Every downgrade survived and is queued for a human, as the doctrine requires.
    expect(result).toMatchObject({ queued: 20 });
    const file = await readJudgments(fixture);
    expect(Object.keys(file.tools)).toHaveLength(20);
    expect(file.tools.host_tool_0!.pending![0]!.value).toBe("read");
    // The repair is reported, not hidden.
    expect([...bus.logs, ...bus.errors].join("\n")).toMatch(/repair/i);
  });

  it("recovers both teable grades from a MISSING `]` on missedSurfaces", async () => {
    const fixture = await host([
      tool("host_tool_0", { risk: "destructive" }),
      tool("host_tool_1", { risk: "destructive" }),
    ]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      loosenings: "queue",
      harness: scripted([
        fence(
          `{\n  "tools": [\n${grade(0)},\n${grade(1)}\n  ],\n`
          + `  "narrative": "Two handlers reviewed.",\n`
          + `  "missedSurfaces": ["The GraphQL surface under packages/core produced zero tools."\n}`,
        ),
        reply({ verdicts: [
          { name: "host_tool_0", field: "risk", verdict: "uphold" },
          { name: "host_tool_1", field: "risk", verdict: "uphold" },
        ] }),
      ]),
    }));

    expect(result.status).toBe("judged");
    expect(result).toMatchObject({ queued: 2 });
    const file = await readJudgments(fixture);
    expect(Object.keys(file.tools)).toHaveLength(2);
    const printed = [...bus.logs, ...bus.errors].join("\n");
    // The advisory that broke the JSON is itself recovered and surfaced.
    expect(printed).toContain("The GraphQL surface under packages/core");
    expect(printed).toMatch(/repair/i);
  });

  it("a genuinely unparseable batch STILL fails loudly — never a silent zero-tools success", async () => {
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([fence(`{"tools": [ %%% this is not json at all `)]),
    }));
    expect(result.status).toBe("skipped");
    expect(bus.errors.join("\n")).toMatch(/warning/i);
    await expect(readFile(fixture.judgmentsPath, "utf8")).rejects.toThrow();
  });

  it("an inner tool object alone is NOT accepted as an empty batch", async () => {
    // The span-scan trap: a bare tool object would satisfy an envelope whose
    // `tools` defaults to [], yielding a cheerful "0 tools judged".
    const fixture = await host([tool("host_a")]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([`{ "name": "host_a", "risk": "read", "evidence": "db.select()" }`]),
    }));
    expect(result.status).toBe("skipped");
    await expect(readFile(fixture.judgmentsPath, "utf8")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BUG 2 backstop: the prompt is the primary fix, but when the model hedges
// upward anyway, a grade that CONTRADICTS its own reason must not auto-apply.
// ---------------------------------------------------------------------------

describe("runJudgmentPass — a risk grade that contradicts its own reason is dropped", () => {
  /** skateshop host_revalidate_list, verbatim shape. */
  it("drops `write` when the reason asserts no data change", async () => {
    const fixture = await host([tool("host_revalidate_list", { risk: "read" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{
          name: "host_revalidate_list",
          risk: "write",
          evidence: "revalidatePath(`/lists/${id}`)",
          reason: "Only invalidates the Next.js path cache for the list route; no data changes.",
        }], narrative: "" }),
        reply({ verdicts: [{ name: "host_revalidate_list", field: "risk", verdict: "uphold" }] }),
      ]),
    }));

    // The spurious HARDENING never lands: the tool keeps its read grade.
    const file = await readJudgments(fixture);
    expect(file.tools.host_revalidate_list?.fields.risk).toBeUndefined();
    expect(result).toMatchObject({ inconsistentRisk: 1 });
    expect([...bus.logs, ...bus.errors].join("\n")).toMatch(/contradict/i);
  });

  /** openstatus host_trpc_edge_get, verbatim shape. */
  it("drops `write` when the reason says the handler dispatches read procedures", async () => {
    const fixture = await host([tool("host_trpc_edge_get", { risk: "read" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{
          name: "host_trpc_edge_get",
          risk: "write",
          evidence: "export const GET = handler",
          reason: "GET dispatches query (read) procedures only; does not mutate stored state.",
        }], narrative: "" }),
        reply({ verdicts: [{ name: "host_trpc_edge_get", field: "risk", verdict: "uphold" }] }),
      ]),
    }));
    const file = await readJudgments(fixture);
    expect(file.tools.host_trpc_edge_get?.fields.risk).toBeUndefined();
    expect(result).toMatchObject({ inconsistentRisk: 1 });
  });

  it("a `read` grade with the same reason is untouched — the rule only catches contradiction", async () => {
    const fixture = await host([tool("host_x", { risk: "destructive" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      loosenings: "queue",
      harness: scripted([
        reply({ tools: [{
          name: "host_x",
          risk: "read",
          evidence: "return db.select()",
          reason: "Read-only handler; no data changes.",
        }], narrative: "" }),
        reply({ verdicts: [{ name: "host_x", field: "risk", verdict: "uphold" }] }),
      ]),
    }));
    // The legitimate downgrade still routes to a human, doctrine intact.
    expect(result).toMatchObject({ queued: 1, inconsistentRisk: 0 });
  });

  it("a genuine `write` whose reason describes a mutation is untouched", async () => {
    const fixture = await host([tool("host_y", { risk: "read" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{
          name: "host_y",
          risk: "write",
          evidence: "await db.update(rows).set({ done: true })",
          reason: "Updates the row's done flag in Postgres.",
        }], narrative: "" }),
        reply({ verdicts: [{ name: "host_y", field: "risk", verdict: "uphold" }] }),
      ]),
    }));
    const file = await readJudgments(fixture);
    expect(file.tools.host_y!.fields.risk).toBe("write");
    expect(result).toMatchObject({ inconsistentRisk: 0 });
  });

  it("a NEGATED claim is not a no-mutation claim (`not read-only`)", async () => {
    const fixture = await host([tool("host_z", { risk: "read" })]);
    const bus = channel();
    const result = await runJudgmentPass(options(fixture, bus, {
      harness: scripted([
        reply({ tools: [{
          name: "host_z",
          risk: "write",
          evidence: "await db.insert(t)",
          reason: "This endpoint is not read-only; it inserts a row.",
        }], narrative: "" }),
        reply({ verdicts: [{ name: "host_z", field: "risk", verdict: "uphold" }] }),
      ]),
    }));
    const file = await readJudgments(fixture);
    expect(file.tools.host_z!.fields.risk).toBe("write");
    expect(result).toMatchObject({ inconsistentRisk: 0 });
  });
});
