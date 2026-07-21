import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_TOOLS_FORMAT } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRefineModel, runRefineCommand } from "./refine.js";
import type { Output } from "./shared.js";

// `vendo refine` CLI surface (ENG-250): diffs are presented and applied only
// on approval; nothing is ever silently applied.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function testOutput(): Output & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: (message) => logs.push(message), error: (message) => errors.push(message) };
}

const TOOLS_FILE = {
  format: VENDO_TOOLS_FORMAT,
  tools: [
    {
      name: "host_listTasks",
      description: "List tasks",
      inputSchema: { type: "object" },
      risk: "read",
      binding: { kind: "route", method: "GET", path: "/api/tasks", argsIn: "query" },
    },
    {
      name: "host_completeTask",
      description: "Complete a task",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      risk: "write",
      binding: { kind: "openapi", operationId: "completeTask", method: "POST", path: "/api/tasks/{id}/complete" },
    },
  ],
} as const;

async function makeRoot(withTools = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vendo-refine-cli-"));
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, ".vendo"), { recursive: true });
  if (withTools) await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify(TOOLS_FILE));
  return root;
}

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

function proposalModel(proposals: unknown): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(proposals) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  }) as LanguageModel;
}

const COMPOUND_PROPOSAL = {
  compounds: [{
    name: "host_complete_open_tasks",
    description: "Complete every open task",
    inputSchema: { type: "object" },
    steps: [
      { id: "list", tool: "host_listTasks" },
      { id: "complete", tool: "host_completeTask", forEach: "steps.list.id", args: { id: "item" } },
    ],
  }],
};

async function transcriptFiles(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, ".vendo", "data", "refine"));
  } catch {
    return [];
  }
}

describe("runRefineCommand", () => {
  it("errors before spending model tokens when .vendo/tools.json is missing", async () => {
    const root = await makeRoot(false);
    const output = testOutput();
    expect(await runRefineCommand({ targetDir: root, output, model: proposalModel({}) })).toBe(1);
    expect(output.errors.join("\n")).toContain("vendo init");
  });

  it("explains model resolution when no key and no --model-import is available", async () => {
    const root = await makeRoot();
    const output = testOutput();
    expect(await runRefineCommand({ targetDir: root, output, env: {}, yes: true })).toBe(1);
    expect(output.errors.join("\n")).toContain("--model-import");
  });

  it("applies an approved diff and records the decision in the transcript", async () => {
    const root = await makeRoot();
    const output = testOutput();
    const confirmed: string[] = [];
    const code = await runRefineCommand({
      targetDir: root,
      output,
      model: proposalModel(COMPOUND_PROPOSAL),
      asks: ["bulk complete"],
      confirm: async (change) => {
        confirmed.push(change.path);
        return true;
      },
    });
    expect(code).toBe(0);
    expect(confirmed).toEqual([".vendo/capabilities.json"]);
    const written = JSON.parse(await readFile(join(root, ".vendo", "capabilities.json"), "utf8")) as { tools: Array<{ name: string }> };
    expect(written.tools[0]!.name).toBe("host_complete_open_tasks");

    const transcripts = await transcriptFiles(root);
    expect(transcripts).toHaveLength(1);
    const transcript = JSON.parse(await readFile(join(root, ".vendo", "data", "refine", transcripts[0]!), "utf8")) as {
      decisions: Array<{ path: string; applied: boolean }>;
      inputs: { interview: string[] };
    };
    expect(transcript.decisions).toEqual([{ path: ".vendo/capabilities.json", applied: true }]);
    expect(transcript.inputs.interview).toEqual(["bulk complete"]);
  });

  it("writes nothing when the diff is declined", async () => {
    const root = await makeRoot();
    const output = testOutput();
    const code = await runRefineCommand({
      targetDir: root,
      output,
      model: proposalModel(COMPOUND_PROPOSAL),
      yes: false,
      asks: ["x"],
      confirm: async () => false,
    });
    expect(code).toBe(0);
    await expect(readFile(join(root, ".vendo", "capabilities.json"), "utf8")).rejects.toThrow();
    const transcripts = await transcriptFiles(root);
    const transcript = JSON.parse(await readFile(join(root, ".vendo", "data", "refine", transcripts[0]!), "utf8")) as {
      decisions: Array<{ path: string; applied: boolean }>;
    };
    expect(transcript.decisions).toEqual([{ path: ".vendo/capabilities.json", applied: false }]);
  });

  it("--yes approves the displayed diffs without a confirm callback", async () => {
    const root = await makeRoot();
    const output = testOutput();
    const code = await runRefineCommand({
      targetDir: root,
      output,
      model: proposalModel(COMPOUND_PROPOSAL),
      yes: true,
    });
    expect(code).toBe(0);
    const written = JSON.parse(await readFile(join(root, ".vendo", "capabilities.json"), "utf8")) as { tools: unknown[] };
    expect(written.tools).toHaveLength(1);
    expect(output.logs.join("\n")).toContain("Applied 1 of 1");
  });

  it("prints probe summaries and drop reasons", async () => {
    const root = await makeRoot();
    const output = testOutput();
    await runRefineCommand({
      targetDir: root,
      output,
      model: proposalModel({
        compounds: [
          COMPOUND_PROPOSAL.compounds[0],
          { name: "host_broken", description: "references unknown", steps: [{ id: "one", tool: "host_nope" }] },
        ],
      }),
      yes: true,
    });
    const log = output.logs.join("\n");
    expect(log).toContain("probe host_complete_open_tasks: static-only");
    expect(output.errors.join("\n")).toContain("dropped compound host_broken");
  });

  it("reports a clean no-op when the model proposes nothing", async () => {
    const root = await makeRoot();
    const output = testOutput();
    expect(await runRefineCommand({ targetDir: root, output, model: proposalModel({}), yes: true })).toBe(0);
    expect(output.logs.join("\n")).toContain("No changes proposed.");
    expect(await transcriptFiles(root)).toHaveLength(1);
  });
});

describe("resolveRefineModel", () => {
  it("loads the host's own ai-SDK model module via --model-import (the provider-agnostic seam)", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "model.mjs"), "export const model = { specificationVersion: 'v3', provider: 'test', modelId: 'stub' };\n");
    const model = await resolveRefineModel({ root, modelImport: "./model.mjs", env: {} });
    expect((model as { modelId: string }).modelId).toBe("stub");
  });

  it("rejects a module that exports no model", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "empty.mjs"), "export const nothing = 1;\n");
    await expect(resolveRefineModel({ root, modelImport: "./empty.mjs", env: {} }))
      .rejects.toThrow(/does not export/);
  });

  it("fails with guidance when ANTHROPIC_API_KEY is absent", async () => {
    const root = await makeRoot();
    await expect(resolveRefineModel({ root, env: {} })).rejects.toThrow(/ANTHROPIC_API_KEY|--model-import/);
  });

  // Release-gap fix (2026-07-20): the default rides the shared dev-credential
  // ladder (the resolver init, doctor, and createVendo compose), so a
  // VENDO_API_KEY-only host gets the Cloud model gateway instead of
  // "no model configured".
  it("resolves VENDO_API_KEY through the Cloud model gateway (the devModel ladder)", async () => {
    const root = await makeRoot();
    const created: Array<{ apiKey: string; baseURL?: string }> = [];
    const model = await resolveRefineModel({
      root,
      env: { VENDO_API_KEY: "vnd_refine_key" },
      importModule: async (_root, specifier) => {
        expect(specifier).toBe("@ai-sdk/anthropic");
        return {
          createAnthropic: (config: { apiKey: string; baseURL?: string }) => {
            created.push(config);
            return (modelId: string) => ({ specificationVersion: "v3", provider: "anthropic", modelId });
          },
        };
      },
    });
    expect(created).toEqual([{ apiKey: "vnd_refine_key", baseURL: "https://console.vendo.run/api/v1" }]);
    expect((model as { modelId: string }).modelId).toBe("claude-sonnet-4-6");
  });

  it("a provider env key still outranks VENDO_API_KEY on the ladder", async () => {
    const root = await makeRoot();
    const created: Array<{ apiKey: string; baseURL?: string }> = [];
    await resolveRefineModel({
      root,
      env: { ANTHROPIC_API_KEY: "sk-ant-refine", VENDO_API_KEY: "vnd_refine_key" },
      importModule: async () => ({
        createAnthropic: (config: { apiKey: string; baseURL?: string }) => {
          created.push(config);
          return (modelId: string) => ({ specificationVersion: "v3", provider: "anthropic", modelId });
        },
      }),
    });
    expect(created).toEqual([{ apiKey: "sk-ant-refine" }]);
  });

  it("--model-import stays the explicit override even with ladder keys set", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "model.mjs"), "export const model = { specificationVersion: 'v3', provider: 'test', modelId: 'own' };\n");
    const model = await resolveRefineModel({
      root,
      modelImport: "./model.mjs",
      env: { ANTHROPIC_API_KEY: "sk-ant", VENDO_API_KEY: "vnd_key" },
      importModule: async () => { throw new Error("the ladder must not resolve when --model-import is passed"); },
    });
    expect((model as { modelId: string }).modelId).toBe("own");
  });
});
