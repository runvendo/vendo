/**
 * The builder's validate gate — blueprint §7.1 item 4, "validate-must-pass before
 * done".
 *
 * Nothing tested this because nothing did it: the `validate` verb was registered,
 * the building-apps skill told the model to call it, and whether it ever did was
 * the model's business. A builder that skipped it reported success over a broken
 * app, and the only thing that noticed was the paint seam refusing to paint —
 * silently, from the model's point of view.
 *
 * The gate calls the SAME registered verb through `turn.tools.call`, so it goes
 * through one guard, one audit row and one mirror like every other call. There is
 * no second validate.
 */
import type {
  Json,
  ToolResult,
} from "@vendoai/core";
import type {
  Finding,
} from "../src/contract/index.js";
import { describe, expect, it, vi } from "vitest";
import { repairInstruction, validateWrittenApps } from "../src/server/generation/validate-gate.js";

const APP = "/user/apps/app_1/app.vendo";
const OTHER = "/user/apps/app_2/app.vendo";

const LYING: Finding = {
  severity: "block",
  where: 'node "text-1" prop "text"',
  message: 'binds /spend/grandTotal: field "grandTotal" is absent from the tool\'s response shape — the real fields are: total',
  check: "bindings-fit",
};

const THIN: Finding = { severity: "warn", where: "document", message: "this app feels thin." };

const answering = (byPath: Record<string, { ok: boolean; findings: Finding[] }>) => {
  const calls: Array<{ name: string; args: Json }> = [];
  const files: Record<string, string> = Object.fromEntries(
    Object.keys(byPath).map((path) => [path, `<App name="${path}" />`]),
  );
  const tools = {
    call: async (name: string, args: Json): Promise<ToolResult> => {
      calls.push({ name, args });
      const document = (args as { document?: string }).document;
      const path = Object.entries(files).find(([, text]) => text === document)?.[0];
      const answer = path === undefined ? undefined : byPath[path];
      return answer === undefined
        ? { status: "error", error: { code: "not-found", message: "no such app" } }
        : { status: "ok", output: answer as unknown as Json };
    },
  };
  const workspace = { readFile: async (path: string) => files[path] ?? "" };
  return { calls, tools, workspace, files };
};

describe("validateWrittenApps", () => {
  it("calls the ONE registered verb, with the wire text it read back", async () => {
    const { calls, tools, workspace, files } = answering({ [APP]: { ok: true, findings: [] } });

    await validateWrittenApps({ tools, workspace, paths: [APP] });

    expect(calls).toEqual([{ name: "validate", args: { document: files[APP] } }]);
  });

  it("reports nothing when every app passes", async () => {
    const { tools, workspace } = answering({ [APP]: { ok: true, findings: [] } });
    expect(await validateWrittenApps({ tools, workspace, paths: [APP] })).toEqual([]);
  });

  it("reports the app that did not pass, with its findings", async () => {
    const { tools, workspace } = answering({ [APP]: { ok: false, findings: [LYING] } });

    const failures = await validateWrittenApps({ tools, workspace, paths: [APP] });

    expect(failures).toEqual([{ path: APP, appId: "app_1", findings: [LYING] }]);
  });

  it("keeps the apps apart when a turn wrote two and only one is broken", async () => {
    const { tools, workspace } = answering({
      [APP]: { ok: true, findings: [] },
      [OTHER]: { ok: false, findings: [LYING] },
    });

    const failures = await validateWrittenApps({ tools, workspace, paths: [APP, OTHER] });

    expect(failures.map(({ appId }) => appId)).toEqual(["app_2"]);
  });

  it("ignores paths that are not an app document", async () => {
    const { calls, tools, workspace } = answering({ [APP]: { ok: true, findings: [] } });

    await validateWrittenApps({
      tools,
      workspace,
      // A plan is a skeleton, not an app document — there is nothing to validate
      // yet. `notes.md` is not ours at all.
      paths: ["/user/apps/app_1/plan.vendo", "/user/memory/notes.md"],
    });

    expect(calls).toEqual([]);
  });

  it("FAILS OPEN when the verb itself could not run", async () => {
    // A `validate` we could not run is not a finding. Treating it as one would
    // spend the builder's fix round repairing an app nobody said was broken, and
    // could refuse a turn because a guard was busy.
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tools = {
      call: async (): Promise<ToolResult> => ({ status: "denied", reason: "the guard is asking" }),
    };
    const workspace = { readFile: async () => "<App name=\"x\" />" };

    expect(await validateWrittenApps({ tools, workspace, paths: [APP] })).toEqual([]);
    // Loud for the operator, though: a gate that stopped gating must not be quiet.
    expect(logged.mock.calls.map(String).join("")).toContain("app_1");
    logged.mockRestore();
  });

  it("fails open on a file it cannot read back", async () => {
    const tools = { call: async (): Promise<ToolResult> => ({ status: "ok", output: null }) };
    const workspace = {
      readFile: async (): Promise<string> => {
        throw new Error("gone");
      },
    };
    expect(await validateWrittenApps({ tools, workspace, paths: [APP] })).toEqual([]);
  });

  it("fails open on an answer it cannot read", async () => {
    const tools = {
      call: async (): Promise<ToolResult> => ({ status: "ok", output: "yep" as unknown as Json }),
    };
    const workspace = { readFile: async () => "<App name=\"x\" />" };
    expect(await validateWrittenApps({ tools, workspace, paths: [APP] })).toEqual([]);
  });
});

describe("repairInstruction", () => {
  it("is undefined when nothing failed, so a clean turn adds no round", () => {
    expect(repairInstruction([])).toBeUndefined();
  });

  it("hands the findings over verbatim — a finding is already a teaching sentence", () => {
    const instruction = repairInstruction([{ path: APP, appId: "app_1", findings: [LYING, THIN] }]);

    expect(instruction).toContain(APP);
    expect(instruction).toContain(LYING.message);
    expect(instruction).toContain(LYING.where!);
    // Warnings ride along: the model is told everything, and only blocks are what
    // made the gate fire.
    expect(instruction).toContain(THIN.message);
  });

  it("names every failing app, so a two-app turn repairs both", () => {
    const instruction = repairInstruction([
      { path: APP, appId: "app_1", findings: [LYING] },
      { path: OTHER, appId: "app_2", findings: [LYING] },
    ]);

    expect(instruction).toContain(APP);
    expect(instruction).toContain(OTHER);
  });
});
