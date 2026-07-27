import { describe, expect, it } from "vitest";
import { modelEngine, verifyDocumentAgainstData, type GeneratedAppDocument, type PipelineEvent } from "./engine.js";
import { dataSightedVerify, NO_VALID_FIX } from "./pipeline.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "./testing/index.js";

/** Rebind-capable data-sighted verify (pipeline.rebind, default OFF) — the
 *  2026-07-26 re-gate's lesson: wrong-data-binding is the top model-error
 *  class in every arm, and the copy-only verify (15 patches across the run)
 *  caught NONE of them, because a relabel can make a lying label honest but
 *  cannot point a binding at the right field. The rebind arm reuses the
 *  structured-repair fix space: a STRICT tool call whose enum is the closed
 *  set of real, kind-compatible field paths — never a free-text binding edit. */

const accountShapes = {
  host_accounts: {
    kind: "object" as const,
    fields: {
      data: {
        kind: "array" as const,
        items: {
          kind: "object" as const,
          fields: {
            id: { kind: "string" as const },
            name: { kind: "string" as const },
            balance: { kind: "number" as const },
          },
        },
      },
      total: { kind: "number" as const },
    },
  },
};

const accountTools = [{ name: "host_accounts", description: "List accounts with balances", risk: "read" }];

const resolved = {
  accounts: {
    data: [
      { id: "acct_1", name: "Checking", balance: 120000 },
      { id: "acct_2", name: "Savings", balance: 230000 },
    ],
    total: 350000,
  },
};

const promptText = (call: ScriptedModelCall): string => call.prompt.map((message) => {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.text ?? "").join("");
}).join("\n");

const isRebindCall = (call: ScriptedModelCall): boolean =>
  call.tools?.[0]?.name === "rebind_bindings";

type Nodes = Array<{ id: string; component: string; props?: Record<string, unknown> }>;

const statOf = (document: GeneratedAppDocument, index = 0) =>
  (document.tree as unknown as { nodes: Nodes }).nodes.filter(({ component }) => component === "Stat")[index];

const deps = (model: unknown, extra: Record<string, unknown> = {}) => ({
  model,
  catalog: [],
  tools: accountTools,
  toolShapes: accountShapes,
  pipeline: { endPass: true, rebind: true },
  ...extra,
}) as unknown as Parameters<typeof verifyDocumentAgainstData>[3];

const buildDocument = async (wire: string): Promise<GeneratedAppDocument> =>
  modelEngine.create({ prompt: "build" }, deps(scriptedLanguageModel(() => wire), { pipeline: {} }));

const lyingStatWire = '<App name="Balances"><Query id="accounts" tool="host_accounts"/><Stack><Stat label="Total balance" value={accounts.data.0.balance}/></Stack></App>';

describe("data-sighted verify — rebind arm (pipeline.rebind, default OFF)", () => {
  it("rebinds the gate's failure shape from the closed enum and keeps the truthful label", async () => {
    // The re-gate's top class verbatim: a Stat claiming "Total balance"
    // bound to ONE account's balance while the digest holds the real total.
    const document = await buildDocument(lyingStatWire);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) return { tool: "rebind_bindings", input: { fix_0: "/accounts/total" } };
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "total balance across my accounts", resolved,
      deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) }),
    );

    expect(statOf(verified)?.props?.value).toEqual({ $path: "/accounts/total" });
    expect(statOf(verified)?.props?.label).toBe("Total balance");
    expect(events).toContainEqual(expect.objectContaining({
      stage: "data-verify", applied: true, relabels: 0, rebinds: 1,
    }));
  });

  it("offers a strict flat schema of kind-compatible REAL paths plus the no-valid-fix arm, with resolved samples", async () => {
    const document = await buildDocument(lyingStatWire);
    let rebindTool: { name?: string; strict?: boolean; inputSchema?: unknown } | undefined;
    let rebindPrompt = "";
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) {
        rebindTool = call.tools?.[0] as typeof rebindTool;
        rebindPrompt = promptText(call);
        return { tool: "rebind_bindings", input: { fix_0: NO_VALID_FIX } };
      }
      return "<Edit></Edit>";
    });

    await verifyDocumentAgainstData(document, "total balance across my accounts", resolved, deps(model));

    expect(rebindTool?.name).toBe("rebind_bindings");
    expect(rebindTool?.strict).toBe(true);
    const schema = rebindTool?.inputSchema as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { enum: string[]; description: string }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["fix_0"]);
    // Stat.value binds a number: number paths stay, strings/arrays/objects
    // are kind-filtered out, the no-valid-fix (keep) arm is always present.
    expect(schema.properties.fix_0?.enum).toContain("/accounts/total");
    expect(schema.properties.fix_0?.enum).toContain("/accounts/data/0/balance");
    expect(schema.properties.fix_0?.enum).toContain(NO_VALID_FIX);
    expect(schema.properties.fix_0?.enum).not.toContain("/accounts/data/0/name");
    expect(schema.properties.fix_0?.enum).not.toContain("/accounts/data");
    // The slot names the current binding and its RESOLVED sample value so the
    // verifier can pick correctly against the digest.
    expect(schema.properties.fix_0?.description).toContain("/accounts/data/0/balance");
    expect(schema.properties.fix_0?.description).toContain("120000");
    // The digest rides the prompt with the path annotation.
    expect(rebindPrompt).toContain("ACTUAL data");
    expect(rebindPrompt).toContain("350000");
    expect(rebindPrompt).toContain("query names");
  });

  it("drops the WHOLE rebind patch when any answer falls outside the enum (original ships)", async () => {
    const document = await buildDocument(lyingStatWire);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      // A string path — outside the kind-filtered enum (defense when strict
      // is not enforced by the transport).
      if (isRebindCall(call)) return { tool: "rebind_bindings", input: { fix_0: "/accounts/data/0/name" } };
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "total balance across my accounts", resolved,
      deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) }),
    );

    expect(statOf(verified)?.props?.value).toEqual({ $path: "/accounts/data/0/balance" });
    expect(events).toContainEqual(expect.objectContaining({
      stage: "data-verify", applied: false, relabels: 0, rebinds: 0,
    }));
  });

  it("applies up to two rebinds in one pass", async () => {
    const twoLies = '<App name="Balances"><Query id="accounts" tool="host_accounts"/><Stack><Stat label="Total balance" value={accounts.data.0.balance}/><Stat label="Savings balance" value={accounts.data.0.balance}/></Stack></App>';
    const document = await buildDocument(twoLies);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) {
        // Both slots answered with in-enum targets (array paths are canonical
        // at index 0 — /accounts/data/1/… is deliberately NOT in the enum).
        return { tool: "rebind_bindings", input: { fix_0: "/accounts/total", fix_1: "/accounts/total" } };
      }
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "total balance and savings balance", resolved,
      deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) }),
    );

    expect(statOf(verified, 0)?.props?.value).toEqual({ $path: "/accounts/total" });
    expect(statOf(verified, 1)?.props?.value).toEqual({ $path: "/accounts/total" });
    expect(events).toContainEqual(expect.objectContaining({ stage: "data-verify", rebinds: 2 }));
  });

  it("drops the whole patch past the 2-rebind cap (3 proposed → none applied)", async () => {
    const threeLies = '<App name="Balances"><Query id="accounts" tool="host_accounts"/><Stack><Stat label="Total balance" value={accounts.data.0.balance}/><Stat label="Savings balance" value={accounts.data.0.balance}/><Stat label="Combined" value={accounts.data.0.balance}/></Stack></App>';
    const document = await buildDocument(threeLies);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) {
        return {
          tool: "rebind_bindings",
          input: { fix_0: "/accounts/total", fix_1: "/accounts/data/1/balance", fix_2: "/accounts/total" },
        };
      }
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "balances", resolved,
      deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) }),
    );

    for (const index of [0, 1, 2]) {
      expect(statOf(verified, index)?.props?.value).toEqual({ $path: "/accounts/data/0/balance" });
    }
    expect(events).toContainEqual(expect.objectContaining({
      stage: "data-verify", applied: false, rebinds: 0,
    }));
  });

  it("ships the original document when the rebound tree fails revalidation", async () => {
    const document = await buildDocument(lyingStatWire);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) return { tool: "rebind_bindings", input: { fix_0: "/accounts/total" } };
      return "<Edit></Edit>";
    });
    const failingDeps = deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) });

    const verified = await dataSightedVerify(document, "total balance", resolved, {
      deps: failingDeps,
      hostComponents: [],
      startedAt: Date.now(),
      // The never-break guarantee: the rebound tree must survive the FULL
      // create validator; a failure ships the pre-rebind document.
      validate: async () => ({ issues: ["synthetic validation failure"] }),
    });

    expect(verified).toEqual(document);
    expect(statOf(verified)?.props?.value).toEqual({ $path: "/accounts/data/0/balance" });
    expect(events).toContainEqual(expect.objectContaining({
      stage: "data-verify", applied: false, rebinds: 0,
    }));
  });

  it("combines a rebind with a relabel — fix the binding AND adjust the label", async () => {
    const mislabeled = '<App name="Balances"><Query id="accounts" tool="host_accounts"/><Stack><Stat label="Checking balance" value={accounts.data.0.balance}/></Stack></App>';
    const document = await buildDocument(mislabeled);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) return { tool: "rebind_bindings", input: { fix_0: "/accounts/total" } };
      const wire = promptText(call);
      const match = /id="(stat-[0-9]+)"/.exec(wire);
      return `<Edit><Set id="${match?.[1] ?? "missing"}" label="Total balance"/></Edit>`;
    });

    const verified = await verifyDocumentAgainstData(
      document, "total balance across my accounts", resolved,
      deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) }),
    );

    expect(statOf(verified)?.props?.value).toEqual({ $path: "/accounts/total" });
    expect(statOf(verified)?.props?.label).toBe("Total balance");
    expect(events).toContainEqual(expect.objectContaining({
      stage: "data-verify", applied: true, relabels: 1, rebinds: 1,
    }));
  });

  it("keeps every binding on all-no-valid-fix and still applies the copy pass", async () => {
    const document = await buildDocument(lyingStatWire);
    const events: PipelineEvent[] = [];
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) return { tool: "rebind_bindings", input: { fix_0: NO_VALID_FIX } };
      const match = /id="(stat-[0-9]+)"/.exec(promptText(call));
      return `<Edit><Set id="${match?.[1] ?? "missing"}" label="Checking balance"/></Edit>`;
    });

    const verified = await verifyDocumentAgainstData(
      document, "how much is in checking", resolved,
      deps(model, { onPipeline: (event: PipelineEvent) => events.push(event) }),
    );

    expect(statOf(verified)?.props?.value).toEqual({ $path: "/accounts/data/0/balance" });
    expect(statOf(verified)?.props?.label).toBe("Checking balance");
    expect(events).toContainEqual(expect.objectContaining({
      stage: "data-verify", applied: true, relabels: 1, rebinds: 0,
    }));
  });

  it("makes NO rebind call without pipeline.rebind (copy-only behavior intact)", async () => {
    const document = await buildDocument(lyingStatWire);
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      const match = /id="(stat-[0-9]+)"/.exec(promptText(call));
      return `<Edit><Set id="${match?.[1] ?? "missing"}" label="Checking balance"/></Edit>`;
    });

    const verified = await verifyDocumentAgainstData(
      document, "total balance", resolved,
      deps(model, { pipeline: { endPass: true } }),
    );

    expect(calls).toHaveLength(1);
    expect(calls.some((call) => isRebindCall(call))).toBe(false);
    expect(statOf(verified)?.props?.value).toEqual({ $path: "/accounts/data/0/balance" });
    expect(statOf(verified)?.props?.label).toBe("Checking balance");
  });

  it("shares the option budget across queries — a path-rich first query cannot starve the query holding the truth", async () => {
    // Greptile P1: options fill first-query-first, so a wide first shape
    // (60+ compatible paths) used to crowd every later query's fields out of
    // the enum — the truthful target could never be chosen.
    const wideShapes = {
      host_wide: {
        kind: "object" as const,
        fields: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
          `metric_${index}`, { kind: "number" as const },
        ])),
      },
      host_totals: {
        kind: "object" as const,
        fields: { grandTotal: { kind: "number" as const } },
      },
    };
    const wideTools = [
      { name: "host_wide", description: "Seventy metrics", risk: "read" },
      { name: "host_totals", description: "The real total", risk: "read" },
    ];
    const wire = '<App name="Wide"><Query id="wide" tool="host_wide"/><Query id="wide2" tool="host_wide"/><Query id="totals" tool="host_totals"/><Stack><Stat label="Grand total" value={wide.metric_0}/></Stack></App>';
    const document = await modelEngine.create({ prompt: "build" }, deps(
      scriptedLanguageModel(() => wire),
      { tools: wideTools, toolShapes: wideShapes, pipeline: {} },
    ));
    let rebindEnum: string[] | undefined;
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) {
        const schema = call.tools?.[0]?.inputSchema as { properties?: { fix_0?: { enum?: string[] } } };
        rebindEnum = schema?.properties?.fix_0?.enum;
        return { tool: "rebind_bindings", input: { fix_0: "/totals/grandTotal" } };
      }
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "the grand total", { wide: {}, totals: { grandTotal: 350000 } },
      deps(model, { tools: wideTools, toolShapes: wideShapes }),
    );

    expect(rebindEnum).toContain("/totals/grandTotal");
    expect(statOf(verified)?.props?.value).toEqual({ $path: "/totals/grandTotal" });
  });

  it("admits shallow fields ahead of deep ones — a truthful aggregate declared last still makes the capped enum", async () => {
    // Greptile P1 follow-up: the enum is bounded (a strict schema must stay
    // small), and DFS enumeration put an earlier field's DEEP descendants
    // ahead of a later shallow sibling — burying exactly the aggregate
    // fields (/q/total) the gate's fail class needs. Candidates are ordered
    // shallow-first per query before the round-robin.
    const deepShapes = {
      host_deep: {
        kind: "object" as const,
        fields: {
          groups: {
            kind: "object" as const,
            fields: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
              `metric_${index}`, { kind: "number" as const },
            ])),
          },
          total: { kind: "number" as const },
        },
      },
    };
    const deepTools = [{ name: "host_deep", description: "Grouped metrics with a total", risk: "read" }];
    const wire = '<App name="Deep"><Query id="deep" tool="host_deep"/><Stack><Stat label="Total" value={deep.groups.metric_0}/></Stack></App>';
    const document = await modelEngine.create({ prompt: "build" }, deps(
      scriptedLanguageModel(() => wire),
      { tools: deepTools, toolShapes: deepShapes, pipeline: {} },
    ));
    let rebindEnum: string[] | undefined;
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) {
        const schema = call.tools?.[0]?.inputSchema as { properties?: { fix_0?: { enum?: string[] } } };
        rebindEnum = schema?.properties?.fix_0?.enum;
        return { tool: "rebind_bindings", input: { fix_0: "/deep/total" } };
      }
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "the total", { deep: { groups: {}, total: 350000 } },
      deps(model, { tools: deepTools, toolShapes: deepShapes }),
    );

    expect(rebindEnum).toContain("/deep/total");
    expect(statOf(verified)?.props?.value).toEqual({ $path: "/deep/total" });
  });

  it("spends the enum budget only on kind-compatible paths — 60+ incompatible fields cannot crowd out the truthful target", async () => {
    // Greptile P1 (third of the family): kind filtering ran AFTER the
    // bounded enumeration, so a shape fronting 60+ string fields exhausted
    // the budget before the compatible number field was ever enumerated.
    const crowdedShapes = {
      host_crowded: {
        kind: "object" as const,
        fields: {
          balance: { kind: "number" as const },
          ...Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
            `note_${index}`, { kind: "string" as const },
          ])),
          total: { kind: "number" as const },
        },
      },
    };
    const crowdedTools = [{ name: "host_crowded", description: "One balance, many notes, a total", risk: "read" }];
    const wire = '<App name="Crowded"><Query id="crowded" tool="host_crowded"/><Stack><Stat label="Total" value={crowded.balance}/></Stack></App>';
    const document = await modelEngine.create({ prompt: "build" }, deps(
      scriptedLanguageModel(() => wire),
      { tools: crowdedTools, toolShapes: crowdedShapes, pipeline: {} },
    ));
    let rebindEnum: string[] | undefined;
    const model = scriptedLanguageModel((call) => {
      if (isRebindCall(call)) {
        const schema = call.tools?.[0]?.inputSchema as { properties?: { fix_0?: { enum?: string[] } } };
        rebindEnum = schema?.properties?.fix_0?.enum;
        return { tool: "rebind_bindings", input: { fix_0: "/crowded/total" } };
      }
      return "<Edit></Edit>";
    });

    const verified = await verifyDocumentAgainstData(
      document, "the total", { crowded: { balance: 120000, total: 350000 } },
      deps(model, { tools: crowdedTools, toolShapes: crowdedShapes }),
    );

    expect(rebindEnum).toContain("/crowded/total");
    expect(rebindEnum).not.toContain("/crowded/note_0");
    expect(statOf(verified)?.props?.value).toEqual({ $path: "/crowded/total" });
  });

  it("skips the rebind call when nothing is rebindable (no shapes → no closed space)", async () => {
    const document = await buildDocument(lyingStatWire);
    const calls: ScriptedModelCall[] = [];
    const model = scriptedLanguageModel((call) => {
      calls.push(call);
      return "<Edit></Edit>";
    });

    await verifyDocumentAgainstData(
      document, "total balance", resolved,
      deps(model, { toolShapes: undefined }),
    );

    expect(calls.some((call) => isRebindCall(call))).toBe(false);
  });
});
