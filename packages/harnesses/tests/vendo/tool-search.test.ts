/**
 * vendo()'s tool-search strategy, driven through the REAL runtime — the new
 * home of the loadout/find_tools intents that used to live on the runtime's
 * discovery rails (`tool-search-connect-ask.test.ts`, `turn-tools.test.ts`).
 *
 * What is pinned, end to end (`createHarnessRuntime` → `vendo({ toolSearch })`):
 *  - the cap binds the model's CHOICE (`activeTools`), while `list()` stays the
 *    full projected surface — curation gates what the model may pick, never
 *    what exists;
 *  - `find_tools` loads a match and it is callable on the very next step;
 *  - the loaded set persists across turns through `turn.state`;
 *  - always-active names (`vendo_*`, the connector-discovery four) are never
 *    gated, whatever the cap (uiaudit 2026-08-06 — a host past the cap lost
 *    `request_connection` while the prompt kept teaching it).
 */
import { CONNECTOR_DISCOVERY_TOOLS, type ThreadId, type ToolListing } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { vendo } from "../../src/vendo/vendo.js";
import {
  computeInitialLoadout,
  FIND_TOOLS_DESCRIPTION,
  FIND_TOOLS_TOOL_NAME,
} from "../../src/vendo/tool-search.js";
import { createHarnessRuntime } from "../../src/runtime.js";
import {
  boundRegistry,
  ctx,
  readSse,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testSkills,
  testTranscript,
  testWorkspace,
  textTurn,
  toolCallTurn,
  userMessage,
  type ScriptedModel,
} from "../../src/test-doubles.test-util.js";

const THREAD = "thr_tool_search" as ThreadId;

/** Three host tools under a cap of two, plus the always-active pair the cap
 *  must never spend itself on. Risk-then-name order picks aaa and bbb, so
 *  `zz_target_ccc` is exactly the long tail `find_tools` exists to reach. */
const CATALOG = {
  host_aaa: { descriptor: readTool("host_aaa"), execute: () => ({ ok: 1 }) },
  host_bbb: { descriptor: readTool("host_bbb"), execute: () => ({ ok: 1 }) },
  zz_target_ccc: { descriptor: readTool("zz_target_ccc"), execute: () => ({ found: true }) },
  request_connection: { descriptor: readTool("request_connection"), execute: () => ({}) },
  vendo_probe: { descriptor: readTool("vendo_probe"), execute: () => ({}) },
};

function rig(model: ScriptedModel) {
  const guard = testGuard();
  const registry = boundRegistry(CATALOG, guard);
  const transcript = testTranscript();
  const runtime = createHarnessRuntime({
    tools: registry,
    guard,
    skills: testSkills(),
    transcript,
  });
  const run = async (messages: Parameters<typeof runtime.run>[0]["messages"]) =>
    readSse(await runtime.run({
      harness: vendo({ toolSearch: { maxInitialTools: 2 } }),
      threadId: THREAD,
      messages,
      ctx: ctx(),
      workspace: testWorkspace(),
      models: seats(model),
      interactive: true,
    }));
  return { registry, transcript, run };
}

describe("vendo({ toolSearch }) through the runtime", () => {
  it("caps the model's choice, loads a match through find_tools, and the match is callable the very next step", async () => {
    const model = scriptedModel([
      toolCallTurn(FIND_TOOLS_TOOL_NAME, { query: "ccc" }),
      toolCallTurn("zz_target_ccc", {}, "c2"),
      textTurn("Found it."),
    ]);
    const { registry, run } = rig(model);
    await run([userMessage("m1", "do the ccc thing")]);

    // Step one: the cap bound what the model may PICK — the long tail is not
    // offered, the always-active names and the meta-hands are.
    const first = model.toolNamesPerCall[0] ?? [];
    expect(first).toContain("host_aaa");
    expect(first).toContain("host_bbb");
    expect(first).not.toContain("zz_target_ccc");
    expect(first).toContain("request_connection");
    expect(first).toContain("vendo_probe");
    expect(first).toContain(FIND_TOOLS_TOOL_NAME);

    // Step two, immediately after the search: the match is choosable…
    expect(model.toolNamesPerCall[1]).toContain("zz_target_ccc");
    // …and it really executed, through the guard-bound registry.
    expect(registry.invocations["zz_target_ccc"]).toBe(1);
  });

  it("persists the loaded set across turns through turn.state", async () => {
    const model = scriptedModel([
      // Turn 1: search the tool in.
      toolCallTurn(FIND_TOOLS_TOOL_NAME, { query: "ccc" }),
      textTurn("Loaded."),
      // Turn 2: no search — the memory is the only way it can be offered.
      textTurn("Still here."),
    ]);
    const { transcript, run } = rig(model);
    await run([userMessage("m1", "find the ccc thing")]);

    const persisted = await transcript.list({ kind: "user", subject: "u1" }, THREAD);
    await run([...persisted, userMessage("m2", "use it again")]);

    // The second turn's FIRST step already offers the searched-in tool.
    const secondTurnFirstStep = model.toolNamesPerCall[2] ?? [];
    expect(secondTurnFirstStep).toContain("zz_target_ccc");
  });
});

describe("the always-active exemption, in the loadout helper itself", () => {
  const listing = (name: string, risk: ToolListing["risk"] = "read"): ToolListing => ({
    name,
    title: `Do ${name}`,
    description: `the ${name} tool`,
    risk,
  });
  const CONNECTOR_LISTINGS = CONNECTOR_DISCOVERY_TOOLS.map((name) => listing(name));
  /** A host well past the cap — the size the cap exists for. */
  const BIG_HOST = Array.from({ length: 200 }, (_, index) =>
    listing(`host_tool_${String(index).padStart(3, "0")}`));

  it("keeps the connector-discovery four past the cap, and does not spend the cap on them", () => {
    const initial = computeInitialLoadout([...BIG_HOST, ...CONNECTOR_LISTINGS], { maxInitialTools: 128 });
    for (const name of CONNECTOR_DISCOVERY_TOOLS) expect([...initial], name).toContain(name);
    // Exempt means exempt: the host's budget is untouched by the four.
    expect([...initial].filter((name) => name.startsWith("host_tool_"))).toHaveLength(128);
  });

  it("keeps them under an explicit loadout that never names them", () => {
    const initial = computeInitialLoadout([...BIG_HOST, ...CONNECTOR_LISTINGS], { loadout: ["host_tool_000"] });
    for (const name of CONNECTOR_DISCOVERY_TOOLS) expect([...initial], name).toContain(name);
    expect([...initial].filter((name) => name.startsWith("host_tool_"))).toEqual(["host_tool_000"]);
  });
});

describe("find_tools does not promise a card nobody asked for", () => {
  /** uiaudit 2026-08-06: the old text said an unconnected service "surfaces an
   *  inline connect card WITHOUT its tools running" — a card that arrives on its
   *  own. It does not: the card is minted by `request_connection`, which the
   *  model has to call. A model that believes the card is coming has a licensed
   *  reason not to ask. */
  it("keeps the true half and names the ask instead of an automatic card", () => {
    expect(FIND_TOOLS_DESCRIPTION).toContain("ask for the service with request_connection");
    expect(FIND_TOOLS_DESCRIPTION).not.toContain("surfaces an inline connect card");
    expect(FIND_TOOLS_DESCRIPTION).not.toContain("WITHOUT its tools running");
  });
});
