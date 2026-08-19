/**
 * How many times one turn projects the host's catalog.
 *
 * `turn.tools.list()` is `registry.descriptors(ctx)` plus the projection over it
 * (turn-tools.ts) — the guard's per-run withholding, a connector's expansion, the
 * whole surface. `vendo()` was asking for it twice before the model saw a token
 * (once to build the wrappers, once to compute the starting loadout), and then
 * again after EVERY tool call, on a rail whose own comment says the only thing
 * that changes the equipped set is a search.
 *
 * The refresh that remains is the one that can matter: the connector-discovery
 * tools, which are the calls that can bring a service's tools into reach.
 * `find_tools` never rode this rail at all — it is the harness's own hand and
 * re-lists inside its own `execute`, which is what makes a found tool callable on
 * the very next step.
 */
import type { ThreadId } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { vendo } from "../../src/vendo/vendo.js";
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

const THREAD = "thr_catalog_reads" as ThreadId;

const CATALOG = {
  host_aaa: { descriptor: readTool("host_aaa"), execute: () => ({ ok: 1 }) },
  host_bbb: { descriptor: readTool("host_bbb"), execute: () => ({ ok: 1 }) },
  request_connection: { descriptor: readTool("request_connection"), execute: () => ({}) },
};

/** One turn, with every catalog projection counted. */
function rig(model: ScriptedModel) {
  const guard = testGuard();
  const registry = boundRegistry(CATALOG, guard);
  let projections = 0;
  const counted = {
    ...registry,
    descriptors: async (...args: Parameters<typeof registry.descriptors>) => {
      projections += 1;
      return registry.descriptors(...args);
    },
  };
  const runtime = createHarnessRuntime({
    tools: counted as typeof registry,
    guard,
    skills: testSkills(),
    transcript: testTranscript(),
  });
  const run = async (): Promise<void> => {
    await readSse(await runtime.run({
      harness: vendo({ toolSearch: { maxInitialTools: 5 } }),
      threadId: THREAD,
      messages: [userMessage("m1", "go")],
      ctx: ctx(),
      workspace: testWorkspace(),
      models: seats(model),
      interactive: true,
    }));
  };
  return { run, projections: () => projections, registry };
}

describe("one turn's catalog projections", () => {
  it("projects the catalog ONCE to set the turn up, not twice", async () => {
    const { run, projections } = rig(scriptedModel([textTurn("nothing to do")]));
    await run();
    // A turn that calls no tool needs the surface exactly once: to build the
    // wrappers AND to compute the starting loadout, which are two readings of
    // one listing, not two listings.
    expect(projections()).toBe(1);
  });

  // The guarded-call path looks its own descriptor up (`descriptorFor`,
  // turn-tools.ts) on every call, whatever the tool. That read belongs to the
  // guard, not to this rail, so it is the baseline both cases below carry and the
  // DIFFERENCE between them is the refresh under test.
  it("does NOT re-project the catalog after a host tool call — a host tool cannot change the surface", async () => {
    const { run, projections, registry } = rig(scriptedModel([
      toolCallTurn("host_aaa", {}),
      textTurn("done"),
    ]));
    await run();
    expect(registry.invocations["host_aaa"]).toBe(1);
    // The turn's one setup projection, plus the guard's own descriptor lookup.
    expect(projections()).toBe(2);
  });

  it("DOES re-project after a connector call — that is the call that can bring new tools into reach", async () => {
    const { run, projections, registry } = rig(scriptedModel([
      toolCallTurn("request_connection", { toolkit: "gmail", reason: "to send it" }),
      textTurn("asked"),
    ]));
    await run();
    expect(registry.invocations["request_connection"]).toBe(1);
    // The same two, and one more: the refresh that makes a newly reachable tool
    // callable on the very next step.
    expect(projections()).toBe(3);
  });
});
