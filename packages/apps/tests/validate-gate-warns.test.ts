/**
 * The reviewer's warns reach the loop.
 *
 * `validate`'s `ok` is block-only (`doors/build-surface.ts`), and the reviewer's
 * rubric hands `block` to two of its five items — so a gate that stopped at `ok`
 * paid for a model call and threw away every dead control, unasked section and
 * quietly dropped piece of work it bought. At the end of a finished screen there is
 * no person to spot those; there is only this loop, about to call it done.
 *
 * Mid-write is unchanged: the only warn the mechanical door can emit is a check
 * that failed to run (`checking/layer.ts`), and fail-open says that is not a
 * finding.
 */
import type { Json, ToolResult } from "@vendoai/core";
import type { Finding } from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { validateWrittenApps } from "../src/server/generation/validate-gate.js";

const APP = "/user/apps/app_1/app.vendo";
const DOCUMENT = '<App name="app_1" />';

const DEAD_CONTROL: Finding = {
  severity: "warn",
  where: '<Button> labeled "Pay"',
  message: 'the row action carries no row id, so it pays nothing; bind the row\'s "id" into its arguments',
};

const CRASHED_CHECK: Finding = {
  severity: "warn",
  where: "screen-types",
  message: 'the check "screen-types" failed to run (boom), so whatever it would have found is missing from this report',
};

/** `validate`, answering the document door and the app door separately. */
const answering = (byDoor: { document: Finding[]; app: Finding[] }) => ({
  tools: {
    call: async (_name: string, args: Json): Promise<ToolResult> => {
      const findings = (args as { document?: string }).document === undefined ? byDoor.app : byDoor.document;
      return {
        status: "ok",
        output: { ok: !findings.some(({ severity }) => severity === "block"), findings } as unknown as Json,
      };
    },
  },
  workspace: { readFile: async () => DOCUMENT },
});

describe("the reviewer door's warns", () => {
  it("fail the turn, so the loop gets one repair round on what only it can see", async () => {
    const { tools, workspace } = answering({ document: [], app: [DEAD_CONTROL] });

    expect(await validateWrittenApps({ tools, workspace, paths: [APP], review: true })).toEqual([
      { path: APP, appId: "app_1", findings: [DEAD_CONTROL] },
    ]);
  });

  it("are not asked for at all when the caller is mid-write", async () => {
    const { tools, workspace } = answering({ document: [], app: [DEAD_CONTROL] });

    expect(await validateWrittenApps({ tools, workspace, paths: [APP] })).toEqual([]);
  });

  it("do not fail the mechanical door, where a warn only means a check crashed", async () => {
    const { tools, workspace } = answering({ document: [CRASHED_CHECK], app: [] });

    expect(await validateWrittenApps({ tools, workspace, paths: [APP], review: true })).toEqual([]);
  });
});
