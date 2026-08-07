import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindingIdentity } from "../binding-identity.js";
import {
  VENDO_JUDGMENTS_FORMAT,
  VENDO_OVERRIDES_FORMAT,
  VENDO_TOOLS_FORMAT,
  type ExtractedTool,
  type ToolJudgment,
} from "../formats.js";
import { createActions } from "./registry.js";

/**
 * The three-layer runtime merge: tools.json (machine) < judgments.json (AI) <
 * overrides.json (human). The judgment layer's safety properties have to hold
 * on the READ path, not just in `applyJudgment`'s unit tests — a pending
 * loosening or a judgment of a handler that moved must be inert once it is
 * actually loaded off disk and composed into the registry.
 */

const HOST = "host_invoices_list";
const BINDING: ExtractedTool["binding"] = { kind: "route", method: "GET", path: "/api/invoices", argsIn: "query" };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function routeTool(extras: Partial<ExtractedTool> = {}): ExtractedTool {
  return {
    name: HOST,
    description: "List invoices",
    inputSchema: { type: "object" },
    risk: "read",
    binding: BINDING,
    ...extras,
  };
}

/** Writes only the files named — an absent key means an absent file. A string
 *  value is written verbatim so malformed content can be exercised. */
async function tempVendo(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-judgments-"));
  roots.push(root);
  await mkdir(join(root, ".vendo"));
  for (const [name, value] of Object.entries(files)) {
    if (value === undefined) continue;
    await writeFile(join(root, ".vendo", `${name}.json`), typeof value === "string" ? value : JSON.stringify(value));
  }
  return root;
}

const toolsFile = (tools: ExtractedTool[]): unknown => ({ format: VENDO_TOOLS_FORMAT, tools });
const overridesFile = (tools: Record<string, unknown>): unknown => ({ format: VENDO_OVERRIDES_FORMAT, tools });
const judgmentsFile = (tools: Record<string, ToolJudgment>): unknown => ({ format: VENDO_JUDGMENTS_FORMAT, tools });

const judgment = (extras: Partial<ToolJudgment> = {}): ToolJudgment => ({
  binding: bindingIdentity(BINDING),
  fields: {},
  evidence: "the handler writes to the invoices table",
  ...extras,
});

const actionsFor = (root: string) =>
  createActions({ dir: root, fetch: vi.fn() as unknown as typeof fetch, baseUrl: "http://stub" });

const hostDescriptor = async (root: string) =>
  (await actionsFor(root).descriptors()).find((descriptor) => descriptor.name === HOST);

describe("three-layer runtime merge: tools.json < judgments.json < overrides.json", () => {
  it("lets the authored override win a risk conflict present in all three files", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool({ risk: "read" })]),
      judgments: judgmentsFile({ [HOST]: judgment({ fields: { risk: "destructive" } }) }),
      overrides: overridesFile({ [HOST]: { risk: "write" } }),
    });
    expect((await hostDescriptor(root))?.risk).toBe("write");
  });

  it("lets a judgment beat tools.json when no override speaks", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool({ risk: "read" })]),
      judgments: judgmentsFile({ [HOST]: judgment({ fields: { risk: "destructive" } }) }),
    });
    expect((await hostDescriptor(root))?.risk).toBe("destructive");
  });

  it("applies a judgment's prose and title over the extracted skeleton", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool()]),
      judgments: judgmentsFile({
        [HOST]: judgment({ fields: { description: "Lists the caller's own invoices", title: "Your invoices" } }),
      }),
    });
    expect(await hostDescriptor(root)).toMatchObject({
      description: "Lists the caller's own invoices",
      title: "Your invoices",
    });
  });

  it("hides a tool a judgment disables", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool()]),
      judgments: judgmentsFile({ [HOST]: judgment({ fields: { disabled: true } }) }),
    });
    expect(await hostDescriptor(root)).toBeUndefined();
  });

  it("hides a tool a judgment grades non-end-user (the audience→disabled coupling reaches the runtime)", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool()]),
      judgments: judgmentsFile({ [HOST]: judgment({ fields: { audience: "operator" } }) }),
    });
    expect(await hostDescriptor(root)).toBeUndefined();
  });

  it("still lets a human override wake a tool a judgment disabled", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool()]),
      judgments: judgmentsFile({ [HOST]: judgment({ fields: { disabled: true } }) }),
      overrides: overridesFile({ [HOST]: { disabled: false } }),
    });
    expect(await hostDescriptor(root)).toBeDefined();
  });
});

describe("judgment safety properties on the runtime read path", () => {
  it("never applies a pending loosening: a queued risk drop leaves the tool destructive", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool({ risk: "destructive" })]),
      judgments: judgmentsFile({
        [HOST]: judgment({
          fields: {},
          pending: [{ field: "risk", value: "read", evidence: "the handler only selects" }],
        }),
      }),
    });
    expect((await hostDescriptor(root))?.risk).toBe("destructive");
  });

  it("never applies a pending loosening: a queued wake-up leaves a disabled tool hidden", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool({ disabled: true })]),
      judgments: judgmentsFile({
        [HOST]: judgment({
          fields: {},
          pending: [{ field: "disabled", value: false, evidence: "the handler is read-only and safe" }],
        }),
      }),
    });
    expect(await hostDescriptor(root)).toBeUndefined();
  });

  it("makes a binding-mismatched judgment wholly inert — a hardening of a handler that moved never lands", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool({ risk: "read" })]),
      judgments: judgmentsFile({
        [HOST]: judgment({ binding: "GET /api/invoices-moved", fields: { risk: "destructive", disabled: true } }),
      }),
    });
    const descriptor = await hostDescriptor(root);
    expect(descriptor).toBeDefined();
    expect(descriptor?.risk).toBe("read");
  });
});

describe("judgments.json load posture", () => {
  it("loads fine when the file is absent — the pair keeps working untouched", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool({ risk: "read" })]),
      overrides: overridesFile({ [HOST]: { title: "Invoices" } }),
    });
    expect(await hostDescriptor(root)).toMatchObject({ risk: "read", title: "Invoices" });
  });

  it("FAILS LOUD on a schema-invalid judgments.json — it carries disables, so ignoring it would silently loosen", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool()]),
      judgments: { format: VENDO_JUDGMENTS_FORMAT, tools: { [HOST]: { binding: "GET /api/invoices", fields: {} } } },
    });
    await expect(actionsFor(root).descriptors()).rejects.toMatchObject({
      message: expect.stringContaining("judgments.json"),
    });
  });

  it("FAILS LOUD on malformed JSON in judgments.json", async () => {
    const root = await tempVendo({
      tools: toolsFile([routeTool()]),
      judgments: "{ definitely-not-json",
    });
    await expect(actionsFor(root).descriptors()).rejects.toMatchObject({
      message: expect.stringContaining("judgments.json"),
    });
  });
});

describe("zero-live-host-tools warning counts judgments", () => {
  it("warns when judgments disabled every host tool — the warning must not read a pre-judgment surface", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message: unknown) => { warned.push(String(message)); });
    try {
      const root = await tempVendo({
        tools: toolsFile([routeTool()]),
        judgments: judgmentsFile({ [HOST]: judgment({ fields: { disabled: true } }) }),
      });
      await actionsFor(root).descriptors();
      expect(warned.filter((line) => line.includes("zero live host tools"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
