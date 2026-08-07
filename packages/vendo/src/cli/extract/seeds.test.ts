import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exists } from "../shared.js";
import { fixturesFileSchema, usecasesFileSchema } from "../try/profile.js";
import type { ExtractionHarness, ExtractionRunInput } from "./harness.js";
import type { StaticTool } from "./stages.js";
import { FALLBACK_USECASES, runSeedsPass } from "./seeds.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function profileRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-seeds-"));
  cleanup.push(root);
  return root;
}

const TOOLS: StaticTool[] = [
  { name: "host_invoices_list", description: "GET /api/invoices", risk: "read", method: "GET", path: "/api/invoices" },
  { name: "host_invoices_create", description: "POST /api/invoices", risk: "write", method: "POST", path: "/api/invoices" },
];

const BRIEF = "Maple is a consumer bank for freelancers.";

function fenced(value: object): string {
  return "```json\n" + JSON.stringify(value) + "\n```";
}

/** A scripted harness for the single seeds run: records inputs, answers or throws. */
function seedsHarness(
  respond: (input: ExtractionRunInput) => object | string | Error,
): { harness: ExtractionHarness; runs: ExtractionRunInput[] } {
  const runs: ExtractionRunInput[] = [];
  return {
    runs,
    harness: {
      id: "scripted",
      availability: async () => "a scripted fake",
      run: async (input) => {
        runs.push(input);
        const response = respond(input);
        if (response instanceof Error) throw response;
        return typeof response === "string" ? response : fenced(response);
      },
    },
  };
}

const ANSWER = {
  usecases: [
    { label: "Build a renewals dashboard", prompt: "Build me a dashboard of upcoming invoice renewals" },
    { label: "Chase overdue invoices", prompt: "Show my overdue invoices and draft reminder messages for each" },
    { label: "Spending overview", prompt: "Visualize my spending by category for this quarter" },
    { label: "Create an invoice", prompt: "Help me create a new invoice for a customer" },
  ],
  fixtures: {
    host_invoices_list: [
      { id: "inv_001", customer: "Ada Lovelace", amountCents: 12500, status: "overdue" },
      { id: "inv_002", customer: "Grace Hopper", amountCents: 4200, status: "paid" },
      { id: "inv_003", customer: "Acme Demo Co", amountCents: 990, status: "open" },
    ],
  },
};

async function readArtifact(root: string, name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ".vendo", "data", "extract", `${name}.json`), "utf8"));
}

describe("runSeedsPass", () => {
  it("writes both artifacts in the profile schemas and returns them on success", async () => {
    const root = await profileRoot();
    const { harness, runs } = seedsHarness(() => ANSWER);
    const result = await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: TOOLS });

    expect(result.status).toBe("written");
    if (result.status !== "written") throw new Error("unreachable");
    expect(result.usecases).toEqual(ANSWER.usecases);
    expect(result.fixtures).toEqual(ANSWER.fixtures);

    // One pass, run against the profile root (never the host repo), fed the
    // brief text and the tool facts.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.root).toBe(root);
    expect(runs[0]?.instructions).toContain(BRIEF);
    expect(runs[0]?.instructions).toContain("host_invoices_list");

    // Both artifacts land where assembleTryProfile reads them and satisfy the
    // imported profile schemas, format literals included.
    const usecasesFile = usecasesFileSchema.parse(await readArtifact(root, "usecases"));
    expect(usecasesFile.format).toBe("vendo/usecases@1");
    expect(usecasesFile.usecases).toEqual(ANSWER.usecases);
    const fixturesFile = fixturesFileSchema.parse(await readArtifact(root, "fixtures"));
    expect(fixturesFile.format).toBe("vendo/fixtures@1");
    expect(fixturesFile.fixtures).toEqual(ANSWER.fixtures);
  });

  it("a harness failure returns fallback chips and writes NOTHING (depth honesty)", async () => {
    const root = await profileRoot();
    const { harness } = seedsHarness(() => new Error("model unreachable"));
    const result = await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: TOOLS });

    expect(result).toEqual({ status: "failed", fallbackUsecases: FALLBACK_USECASES });
    expect(FALLBACK_USECASES).toHaveLength(3);
    expect(await exists(join(root, ".vendo"))).toBe(false);
  });

  it("an unparseable answer fails the same way, writing nothing", async () => {
    const root = await profileRoot();
    const { harness } = seedsHarness(() => "sorry, no JSON today");
    const result = await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: TOOLS });

    expect(result).toEqual({ status: "failed", fallbackUsecases: FALLBACK_USECASES });
    expect(await exists(join(root, ".vendo"))).toBe(false);
  });

  it("a schema-violating answer (zero chips) fails the same way, writing nothing", async () => {
    const root = await profileRoot();
    const { harness } = seedsHarness(() => ({ usecases: [], fixtures: {} }));
    const result = await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: TOOLS });

    expect(result).toEqual({ status: "failed", fallbackUsecases: FALLBACK_USECASES });
    expect(await exists(join(root, ".vendo"))).toBe(false);
  });

  it("a mid-write failure removes the already-written artifact (depth honesty)", async () => {
    const root = await profileRoot();
    // fixtures.json pre-created as a DIRECTORY: writeText(usecases.json)
    // succeeds, then writeText(fixtures.json) throws EISDIR — the exact
    // half-written-pair window the catch must clean up.
    await mkdir(join(root, ".vendo", "data", "extract", "fixtures.json"), { recursive: true });
    const { harness } = seedsHarness(() => ANSWER);
    const result = await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: TOOLS });

    expect(result).toEqual({ status: "failed", fallbackUsecases: FALLBACK_USECASES });
    expect(await exists(join(root, ".vendo", "data", "extract", "usecases.json"))).toBe(false);
  });

  it("drops fixture keys that name no extracted tool", async () => {
    const root = await profileRoot();
    const { harness } = seedsHarness(() => ({
      ...ANSWER,
      fixtures: {
        ...ANSWER.fixtures,
        hallucinated_tool: [{ id: "row_001" }, { id: "row_002" }, { id: "row_003" }],
      },
    }));
    const result = await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: TOOLS });

    expect(result.status).toBe("written");
    if (result.status !== "written") throw new Error("unreachable");
    expect(result.fixtures).toEqual(ANSWER.fixtures);
    const fixturesFile = fixturesFileSchema.parse(await readArtifact(root, "fixtures"));
    expect(fixturesFile.fixtures).toEqual(ANSWER.fixtures);
  });

  it("a null brief still composes (unknown product) and the pass still succeeds", async () => {
    const root = await profileRoot();
    const { harness, runs } = seedsHarness(() => ({ usecases: ANSWER.usecases }));
    const result = await runSeedsPass({ harness, profileRoot: root, brief: null, tools: TOOLS });

    expect(runs[0]?.instructions).toContain("unknown product");
    expect(result.status).toBe("written");
    // fixtures omitted by the model degrades to an empty (still valid) file.
    const fixturesFile = fixturesFileSchema.parse(await readArtifact(root, "fixtures"));
    expect(fixturesFile.fixtures).toEqual({});
  });

  it("caps the tools carried into the instructions so the prompt stays bounded", async () => {
    const root = await profileRoot();
    const many: StaticTool[] = Array.from({ length: 50 }, (_, index) => ({
      name: `host_tool_${index}`,
      description: `tool ${index}`,
      risk: "read",
    }));
    const { harness, runs } = seedsHarness(() => ANSWER);
    await runSeedsPass({ harness, profileRoot: root, brief: BRIEF, tools: many });

    expect(runs[0]?.instructions).toContain("host_tool_0");
    expect(runs[0]?.instructions).toContain("host_tool_39");
    expect(runs[0]?.instructions).not.toContain("host_tool_40");
    expect(runs[0]?.instructions).toContain("first 40 of 50");
  });
});
