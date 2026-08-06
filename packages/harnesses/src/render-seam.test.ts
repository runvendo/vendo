/**
 * Build contract §1.6, the hot-path render seam: every store write to a hot-path
 * file (`app.vendo`, `plan.vendo`) that PARSES makes the runtime emit today's
 * `data-vendo-view` part — same payload, same stable per-app stream id. An
 * unparseable write emits NOTHING and the last good view stays on screen.
 * Harnesses never yield view events; only this seam emits them.
 *
 * The store-write moment is `commit()`, not `writeFile` (orchestrator seam answer
 * after lane B landed): the façade stages writes in memory and
 * `CommitResult.changed` names exactly what reached the store. So every case here
 * writes AND commits, which is what the runtime makes happen for the harness.
 */
import { vendoViewPartSchema, vendoViewStreamId, type Json, type VendoViewPart } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { HOT_PATH_FILES, HOT_PATH_WATCH, hotPathAppId, wrapWorkspaceForRender } from "./render-seam.js";
import { testWorkspace } from "./test-doubles.test-util.js";

const APP = "app_1";
const APP_VENDO = `/user/apps/${APP}/app.vendo`;
const PLAN_VENDO = `/user/apps/${APP}/plan.vendo`;

const GOOD_APP = `<App name="Invoices">
  <Stack>
    <Text value="Hello" />
  </Stack>
</App>`;

const GOOD_PLAN = `<Plan name="Invoices">
  <Group title="Unpaid">
    <Leaf component="Table" />
  </Group>
</Plan>`;

function seam(files: Record<string, string> = {}) {
  const inner = testWorkspace(files);
  const emitted: Array<{ id: string; part: VendoViewPart }> = [];
  const workspace = wrapWorkspaceForRender(inner, {
    emit: (id, part) => emitted.push({ id, part }),
  });
  /** Write then commit — what the runtime does for every in-process edit. */
  const save = async (path: string, content: string): Promise<void> => {
    await workspace.writeFile(path, content);
    await workspace.commit();
  };
  return { workspace, inner, emitted, save };
}

describe("hot paths", () => {
  it("are exactly app.vendo and plan.vendo (§1.6)", () => {
    expect([...HOT_PATH_FILES]).toEqual(["app.vendo", "plan.vendo"]);
  });

  it("reads the appId out of the frozen §3.1 layout, verbatim", () => {
    expect(hotPathAppId("/user/apps/app_42/app.vendo")).toBe("app_42");
    expect(hotPathAppId("/user/apps/app_42/plan.vendo")).toBe("app_42");
  });

  it("refuses paths outside the frozen layout", () => {
    expect(hotPathAppId("/user/apps/app_1/notes.md")).toBeUndefined();
    expect(hotPathAppId("/user/memory/app.vendo")).toBeUndefined();
    expect(hotPathAppId("/user/scratch/app_1/app.vendo")).toBeUndefined();
    // Not an appId the store would ever mint.
    expect(hotPathAppId("/user/apps/nope/app.vendo")).toBeUndefined();
  });

  it("watches BOTH mounts — a team app's skeleton has to paint mid-turn too", () => {
    expect([...HOT_PATH_WATCH]).toEqual([
      "/user/apps/*/app.vendo",
      "/user/apps/*/plan.vendo",
      "/orgs/*/apps/*/app.vendo",
      "/orgs/*/apps/*/plan.vendo",
    ]);
    // Every watch shape must resolve to a path the seam itself calls hot, or the
    // mid-turn collect asks for files the sync would then drop.
    for (const pattern of HOT_PATH_WATCH) {
      expect(hotPathAppId(pattern.replace("/orgs/*/", "/orgs/acme/").replace("/apps/*/", "/apps/app_1/")))
        .toBe("app_1");
    }
  });
});

describe("commit is the store-write moment", () => {
  it("a staged write alone emits nothing — nothing has landed yet", async () => {
    const { workspace, emitted } = seam();
    await workspace.writeFile(APP_VENDO, GOOD_APP);
    expect(emitted).toHaveLength(0);
  });

  it("the commit that lands it is what emits", async () => {
    const { workspace, emitted } = seam();
    await workspace.writeFile(APP_VENDO, GOOD_APP);
    await workspace.commit();
    expect(emitted).toHaveLength(1);
  });

  it("a conflicted commit emits nothing — the last good view stays on screen", async () => {
    const { workspace, inner, emitted } = seam();
    await workspace.writeFile(APP_VENDO, GOOD_APP);
    inner.conflictOn = [APP_VENDO];
    await expect(workspace.commit()).resolves.toEqual({ status: "conflict", paths: [APP_VENDO] });
    expect(emitted).toHaveLength(0);
  });

  it("emits only for the hot paths in `changed`, not for every path committed", async () => {
    const { workspace, emitted } = seam();
    await workspace.writeFile("/user/memory/notes.md", "some notes");
    await workspace.writeFile(APP_VENDO, GOOD_APP);
    const result = await workspace.commit();
    expect(result).toMatchObject({ status: "ok" });
    expect((result as { changed: string[] }).changed).toHaveLength(2);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.part.appId).toBe(APP);
  });

  it("a commit with nothing staged is a no-op", async () => {
    const { workspace, emitted } = seam();
    await workspace.commit();
    expect(emitted).toHaveLength(0);
  });
});

describe("a parsing save to app.vendo", () => {
  it("emits data-vendo-view on the stable per-app stream id", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.id).toBe(vendoViewStreamId(APP));
    expect(emitted[0]!.part.type).toBe("data-vendo-view");
    expect(emitted[0]!.part.appId).toBe(APP);
  });

  it("emits a payload today's renderer accepts (assembled tree)", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    const parsed = vendoViewPartSchema.safeParse(emitted[0]!.part);
    expect(parsed.success).toBe(true);
    const payload = emitted[0]!.part.payload as { root: string; nodes: unknown[] };
    expect(payload.root).toBe("root");
    expect(payload.nodes.length).toBeGreaterThan(0);
  });

  it("strips the server-authoritative fields the client must never be told", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    const serialized = JSON.stringify(emitted[0]!.part.payload);
    expect(serialized).not.toContain("inClient");
    expect(serialized).not.toContain("pinDrift");
  });

  it("emits again on every save — granularity is per file save", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    await save(APP_VENDO, GOOD_APP.replace("Hello", "Goodbye"));
    expect(emitted).toHaveLength(2);
    expect(emitted.every((entry) => entry.id === vendoViewStreamId(APP))).toBe(true);
  });

  it("SETTLES the paint — a finished app must leave \"Building your view…\"", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    // Stamped streaming, the renderer holds the forming skeleton forever: no
    // verdict, no settle-scroll, no pin affordance. The app half not being
    // wired changes nothing — this is still the last paint of this commit.
    expect((emitted[0]!.part.payload as { streaming?: boolean }).streaming).toBe(false);
  });

  it("emits for appendFile too — the seam is the commit, not the write method", async () => {
    const { workspace, emitted } = seam({ [APP_VENDO]: "" });
    await workspace.appendFile(APP_VENDO, GOOD_APP);
    await workspace.commit();
    expect(emitted).toHaveLength(1);
  });
});

describe("a non-parsing save", () => {
  it("emits nothing, so the last good view stays on screen", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    expect(emitted).toHaveLength(1);
    // Not wire markup at all: the brokenness reaches the harness through
    // `validate`, never the user.
    await save(APP_VENDO, "just some prose, no elements at all");
    expect(emitted).toHaveLength(1);
  });

  it("emits nothing for an empty file", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, "");
    expect(emitted).toHaveLength(0);
  });

  it("still lands the write — the seam never swallows a store write", async () => {
    const { workspace, inner, save } = seam();
    await save(APP_VENDO, "not markup");
    await expect(workspace.readFile(APP_VENDO)).resolves.toBe("not markup");
    expect(inner.commits.at(-1)?.changed).toEqual([APP_VENDO]);
  });

  it("a failing emit never fails the commit", async () => {
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      emit: () => {
        throw new Error("the writer is gone");
      },
    });
    await workspace.writeFile(APP_VENDO, GOOD_APP);
    await expect(workspace.commit()).resolves.toMatchObject({ status: "ok" });
    await expect(workspace.readFile(APP_VENDO)).resolves.toBe(GOOD_APP);
  });
});

describe("a save to plan.vendo", () => {
  it("emits the skeleton so it renders the moment the plan file exists", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, GOOD_PLAN);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.id).toBe(vendoViewStreamId(APP));
    const payload = emitted[0]!.part.payload as { nodes: unknown[] };
    expect(payload.nodes.length).toBeGreaterThan(0);
    // A plan IS the mid-build state: this one stays streaming, which is what
    // holds the forming skeleton instead of judging a tree still being written.
    expect((emitted[0]!.part.payload as { streaming?: boolean }).streaming).toBe(true);
  });

  it("emits nothing for a plan that does not parse", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, "there is no plan document here");
    expect(emitted).toHaveLength(0);
  });
});

/** Redesign spec §5: the brain declares the arrival posture at PLAN time, so the
 *  stage can open at build start. The seam is the only thing that carries it to
 *  the client, on the same part the skeleton rides. */
describe("the plan's display hint", () => {
  const planWith = (head: string) => `<${head}>
  <Group title="Unpaid">
    <Leaf component="Table" />
  </Group>
</Plan>`;

  it("rides the view part as top-level payload.display", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, planWith('Plan name="Money HQ" display="stage"'));
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.part.payload as { display?: string }).display).toBe("stage");
  });

  it("carries inline just as faithfully — a wrong hint costs one tap, a lost one costs the posture", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, planWith('Plan name="Balance" display="inline"'));
    expect((emitted[0]!.part.payload as { display?: string }).display).toBe("inline");
  });

  it("stays absent when the plan declares none", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, planWith('Plan name="Balance"'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.part.payload).not.toHaveProperty("display");
  });

  it("is a plan-time hint only — an app.vendo save never invents one", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    expect(emitted[0]!.part.payload).not.toHaveProperty("display");
  });
});

describe("the app half of an app.vendo commit (§1.6)", () => {
  /** The wire the E2E defect was found on: a value that only exists once the
   *  query has run. Painted with no data it reads "—". */
  const WITH_QUERY = `<App name="Spending">
  <Query id="spend" tool="maple_spend_summary" />
  <Stack>
    <Text text={spend.total} />
  </Stack>
</App>`;

  function appSeam(data: Record<string, Json> | undefined, dataUnavailable = false) {
    const calls: Array<{ appId: string; name: string | undefined; queries: number }> = [];
    const emitted: Array<{ id: string; part: VendoViewPart }> = [];
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      emit: (id, part) => emitted.push({ id, part }),
      authoredApp: async ({ appId, compiled }) => {
        calls.push({
          appId,
          name: compiled.name,
          queries: compiled.tree.queries?.length ?? 0,
        });
        return data === undefined ? undefined : { data, ...(dataUnavailable ? { dataUnavailable } : {}) };
      },
    });
    const save = async (path: string, content: string): Promise<void> => {
      await workspace.writeFile(path, content);
      await workspace.commit();
    };
    return { calls, emitted, save, workspace };
  }

  it("hands the compiled document over, so the row and the queries are the runtime's to resolve", async () => {
    const { calls, save } = appSeam({});
    await save(APP_VENDO, WITH_QUERY);
    expect(calls).toEqual([{ appId: APP, name: "Spending", queries: 1 }]);
  });

  it("paints the data it answers with — the fix for an app of em-dashes", async () => {
    const { emitted, save } = appSeam({ spend: { total: 4210 } });
    await save(APP_VENDO, WITH_QUERY);
    expect((emitted.at(-1)!.part.payload as { data?: unknown }).data)
      .toEqual({ spend: { total: 4210 } });
  });

  it("emits the skeleton FIRST, on the same stream id — §1.6 is a promise about seconds", async () => {
    const { emitted, save } = appSeam({ spend: { total: 4210 } });
    await save(APP_VENDO, WITH_QUERY);
    expect(emitted).toHaveLength(2);
    expect(new Set(emitted.map((entry) => entry.id))).toEqual(new Set([vendoViewStreamId(APP)]));
    // The first write is on screen before any host query has run.
    expect((emitted[0]!.part.payload as { data?: unknown }).data).toBeUndefined();
    expect((emitted[0]!.part.payload as { streaming?: boolean }).streaming).toBe(true);
  });

  it("streams the skeleton and SETTLES the paint that carries the data", async () => {
    const { emitted, save } = appSeam({ spend: { total: 4210 } });
    await save(APP_VENDO, WITH_QUERY);
    expect(emitted.map((entry) => (entry.part.payload as { streaming?: boolean }).streaming))
      .toEqual([true, false]);
  });

  it("never mutates the part it already emitted when the data lands", async () => {
    const { emitted, save } = appSeam({ spend: { total: 4210 } });
    await save(APP_VENDO, WITH_QUERY);
    expect((emitted[0]!.part.payload as { data?: unknown }).data).toBeUndefined();
  });

  it("is not called for plan.vendo — a plan is a skeleton, not an app document", async () => {
    const { calls, emitted, save } = appSeam({});
    await save(
      PLAN_VENDO,
      `<Plan name="Invoices"><Group title="Unpaid"><Leaf component="Table" /></Group></Plan>`,
    );
    expect(calls).toEqual([]);
    expect(emitted).toHaveLength(1);
  });

  it("is not called for a save that does not parse — nothing is stored for a non-app", async () => {
    const { calls, save } = appSeam({});
    await save(APP_VENDO, "just some prose, no elements at all");
    expect(calls).toEqual([]);
  });

  it("still renders when it answers nothing at all", async () => {
    const { emitted, save } = appSeam(undefined);
    await save(APP_VENDO, WITH_QUERY);
    expect(emitted.at(-1)!.part.appId).toBe(APP);
    expect((emitted.at(-1)!.part.payload as { data?: unknown }).data).toBeUndefined();
  });

  it("a throwing app half never fails the commit, and the view still SETTLES", async () => {
    const emitted: Array<{ id: string; part: VendoViewPart }> = [];
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      emit: (id, part) => emitted.push({ id, part }),
      authoredApp: async () => {
        throw new Error("the store is gone");
      },
    });
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
    try {
      await workspace.writeFile(APP_VENDO, WITH_QUERY);
      await expect(workspace.commit()).resolves.toMatchObject({ status: "ok" });
    } finally {
      spy.mockRestore();
    }
    // The streaming skeleton is already on screen when the app half runs, so a
    // throw that escaped would leave the card on "Building your view…" forever.
    // It settles instead, data-less, on the same stream id: an app of "—" beats a
    // permanent spinner, and the operator is the one who hears about the failure.
    expect(emitted.map((entry) => (entry.part.payload as { streaming?: boolean }).streaming))
      .toEqual([true, false]);
    expect(new Set(emitted.map((entry) => entry.id))).toEqual(new Set([vendoViewStreamId(APP)]));
    expect((emitted.at(-1)!.part.payload as { data?: unknown }).data).toBeUndefined();
    expect(logs.map((entry) => String(entry[0])).join("\n")).toContain("the store is gone");
  });

  it("marks the settled view as UNABLE TO LOAD its data, so it cannot read as empty data", async () => {
    // Settling is only half the honesty: every unresolved binding renders "—", so
    // a silent settle tells the user "you have no spending". The failure rides the
    // payload as a server-written extra and the renderer says so in the surface.
    const emitted: Array<{ id: string; part: VendoViewPart }> = [];
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      emit: (id, part) => emitted.push({ id, part }),
      authoredApp: async () => {
        throw new Error("the store is gone");
      },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await workspace.writeFile(APP_VENDO, WITH_QUERY);
      await workspace.commit();
    } finally {
      spy.mockRestore();
    }
    const last = emitted.at(-1)!.part.payload as { streaming?: boolean; dataUnavailable?: boolean };
    expect(last.dataUnavailable).toBe(true);
    // …and it still SETTLES: neither symptom ships.
    expect(last.streaming).toBe(false);
    // The skeleton already on screen when the app half ran says nothing about a
    // failure that had not happened yet.
    expect((emitted[0]!.part.payload as { dataUnavailable?: boolean }).dataUnavailable).toBeUndefined();
  });

  it("marks the view when the app half RAN and its queries failed, not only when it threw", async () => {
    // The failure users actually hit: the app half answers fine, and the query
    // inside it was refused or errored — so the data is missing with nothing
    // thrown anywhere. Without this the marker only ever fired on a throw, and
    // the common case shipped as "you have no spending".
    const { emitted, save } = appSeam({}, true);
    await save(APP_VENDO, WITH_QUERY);

    const last = emitted.at(-1)!.part.payload as { streaming?: boolean; dataUnavailable?: boolean };
    expect(last.dataUnavailable).toBe(true);
    expect(last.streaming).toBe(false);
  });

  it("marks nothing when the app half ANSWERS — an empty answer is empty data, not a failure", async () => {
    const answers: Array<Record<string, Json> | undefined> = [{ spend: { total: 4210 } }, {}, undefined];
    for (const answer of answers) {
      const { emitted, save } = appSeam(answer);
      await save(APP_VENDO, WITH_QUERY);
      expect((emitted.at(-1)!.part.payload as { dataUnavailable?: boolean }).dataUnavailable)
        .toBeUndefined();
    }
  });

  it("never lets the plan overwrite the app when ONE commit carries both files", async () => {
    // Both hot-path files write the SAME stream id, so whichever emits last is
    // what the person is left looking at — and `changed` order belongs to the
    // store (sorted, so `app.vendo` first), not to the harness. Pin both orders:
    // the app's data must survive either way.
    for (const staged of [[PLAN_VENDO, APP_VENDO], [APP_VENDO, PLAN_VENDO]]) {
      const { emitted, workspace } = appSeam({ spend: { total: 4210 } });
      for (const path of staged) {
        await workspace.writeFile(path, path === APP_VENDO ? WITH_QUERY : GOOD_PLAN);
      }
      await workspace.commit();
      // Exactly the app's own two paints — the plan yields rather than adding a
      // third, data-less one.
      expect(emitted.map((entry) => entry.id))
        .toEqual([vendoViewStreamId(APP), vendoViewStreamId(APP)]);
      expect((emitted.at(-1)!.part.payload as { data?: unknown }).data)
        .toEqual({ spend: { total: 4210 } });
      expect((emitted.at(-1)!.part.payload as { streaming?: boolean }).streaming).toBe(false);
    }
  });

  it("still paints the plan when the app.vendo in the SAME commit renders nothing", async () => {
    // The plan yields to an app that PAINTED, never to one that merely CHANGED.
    // A commit carrying the plan plus an app document that emits nothing — prose,
    // or a document with no children — must still leave the skeleton on screen;
    // yielding to it blanks the pane for the length of the turn, which is the one
    // thing §1.6's skeleton exists to prevent.
    const nonRendering = ["just some prose, no elements at all", `<App name="Invoices"></App>`];
    for (const app of nonRendering) {
      for (const staged of [[PLAN_VENDO, APP_VENDO], [APP_VENDO, PLAN_VENDO]]) {
        const { calls, emitted, workspace } = appSeam({ spend: { total: 4210 } });
        for (const path of staged) {
          await workspace.writeFile(path, path === APP_VENDO ? app : GOOD_PLAN);
        }
        await workspace.commit();
        // Nothing was stored for a non-app, and the plan's skeleton is the view.
        expect(calls).toEqual([]);
        expect(emitted).toHaveLength(1);
        expect(emitted[0]!.id).toBe(vendoViewStreamId(APP));
        expect((emitted[0]!.part.payload as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
        expect((emitted[0]!.part.payload as { streaming?: boolean }).streaming).toBe(true);
      }
    }
  });

  it("yields only for the app in the SAME commit — another app's plan still paints", async () => {
    const other = "app_2";
    const { emitted, workspace } = appSeam({ spend: { total: 4210 } });
    await workspace.writeFile(APP_VENDO, WITH_QUERY);
    await workspace.writeFile(PLAN_VENDO, GOOD_PLAN);
    await workspace.writeFile(`/user/apps/${other}/plan.vendo`, GOOD_PLAN);
    await workspace.commit();
    const forOther = emitted.filter((entry) => entry.id === vendoViewStreamId(other));
    expect(forOther).toHaveLength(1);
    expect((forOther[0]!.part.payload as { streaming?: boolean }).streaming).toBe(true);
    expect((emitted.filter((entry) => entry.id === vendoViewStreamId(APP)).at(-1)!
      .part.payload as { data?: unknown }).data).toEqual({ spend: { total: 4210 } });
  });
});

describe("saves that are not hot paths", () => {
  it("emit nothing", async () => {
    const { emitted, save } = seam();
    await save("/user/memory/notes.md", GOOD_APP);
    await save(`/user/apps/${APP}/README.md`, GOOD_APP);
    await save("/user/scratch/draft.vendo", GOOD_APP);
    expect(emitted).toHaveLength(0);
  });
});

/**
 * Contract §2.2/§3.2 — the SAME interception point, for the app's own source.
 *
 * `commit()` is the store-write moment for source exactly as it is for a view, and
 * for the extra reason stated in this file's header: the sandbox sync-back path
 * commits without ever calling `writeFile` on this façade, so a builder working in
 * a box reaches the store here and nowhere else. Until this seam existed
 * `checkoutApp`/`commitApp` had zero production callers and every built app's code
 * lived only inside its sandbox snapshot.
 */
describe("source persistence", () => {
  const OTHER = "app_2";

  function sourceSeam() {
    const inner = testWorkspace();
    const calls: Array<{ appId: string; changed: readonly string[]; sameWorkspace: boolean }> = [];
    let fail: string | undefined;
    const workspace = wrapWorkspaceForRender(inner, {
      emit: () => undefined,
      commitSource: async (input) => {
        calls.push({
          appId: input.appId,
          changed: input.changed,
          sameWorkspace: input.workspace === inner,
        });
        if (fail !== undefined) throw new Error(fail);
      },
    });
    return { workspace, inner, calls, failWith: (message: string) => { fail = message; } };
  }

  it("runs for a commit that lands an app's source file", async () => {
    const { workspace, calls } = sourceSeam();
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "export const App = () => null;\n");
    await workspace.commit();
    expect(calls).toEqual([{
      appId: APP,
      changed: [`/user/apps/${APP}/src/App.tsx`],
      sameWorkspace: true,
    }]);
  });

  it("hands over CommitResult.changed verbatim — the paths that actually landed", async () => {
    const { workspace, calls } = sourceSeam();
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "a\n");
    await workspace.writeFile(`/user/apps/${APP}/vendo.json`, "{}\n");
    await workspace.writeFile("/user/memory/notes.md", "mine\n");
    const result = await workspace.commit();
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.changed).toEqual(result.status === "ok" ? result.changed : []);
  });

  it("runs once per APP when one commit touches several", async () => {
    const { workspace, calls } = sourceSeam();
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "one\n");
    await workspace.writeFile(`/orgs/maple/apps/${OTHER}/src/App.tsx`, "two\n");
    await workspace.writeFile(`/user/apps/${APP}/vendo.json`, "{}\n");
    await workspace.commit();
    expect(calls.map((call) => call.appId).sort()).toEqual([APP, OTHER]);
  });

  it("reads the app out of BOTH mounts — a team app's source is source too", async () => {
    const { workspace, calls } = sourceSeam();
    await workspace.writeFile(`/orgs/maple/apps/${OTHER}/src/App.tsx`, "team\n");
    await workspace.commit();
    expect(calls.map((call) => call.appId)).toEqual([OTHER]);
  });

  it("does not run for a commit that landed nothing — a conflict is not a write", async () => {
    const { workspace, inner, calls } = sourceSeam();
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "a\n");
    inner.conflictOn = [`/user/apps/${APP}/src/App.tsx`];
    expect(await workspace.commit()).toEqual({
      status: "conflict",
      paths: [`/user/apps/${APP}/src/App.tsx`],
    });
    expect(calls).toHaveLength(0);
  });

  it("does not run for paths that are not inside an app's directory", async () => {
    const { workspace, calls } = sourceSeam();
    await workspace.writeFile("/user/memory/notes.md", "mine\n");
    await workspace.writeFile("/user/files/report.pdf", "pdf\n");
    await workspace.writeFile("/user/apps/nope/src/App.tsx", "not an appId\n");
    await workspace.commit();
    expect(calls).toHaveLength(0);
  });

  /**
   * The seam's standing rule, inherited: "a view is a courtesy on top of a landed
   * commit; it can never fail one." Source persistence gets the same treatment —
   * but unlike a view, a silently dropped source file is a LOST APP, so the
   * failure is loud.
   */
  it("never fails the commit it rides on, and says so loudly", async () => {
    const { workspace, inner, calls, failWith } = sourceSeam();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failWith("the store said no");
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "a\n");
    await expect(workspace.commit()).resolves.toEqual({
      status: "ok",
      changed: [`/user/apps/${APP}/src/App.tsx`],
    });
    expect(calls).toHaveLength(1);
    // The commit itself landed, exactly once.
    expect(inner.commits).toHaveLength(1);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("source did not reach the store"),
      expect.objectContaining({ appId: APP, error: "the store said no" }),
    );
    spy.mockRestore();
  });

  it("unwired, a commit behaves exactly as it did — the snapshot stays the only home", async () => {
    const inner = testWorkspace();
    const workspace = wrapWorkspaceForRender(inner, { emit: () => undefined });
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "a\n");
    await expect(workspace.commit()).resolves.toEqual({
      status: "ok",
      changed: [`/user/apps/${APP}/src/App.tsx`],
    });
  });

  /**
   * Views go FIRST for two reasons. §1.6 is a promise about seconds, and — the
   * load-bearing one — an `app.vendo` commit is the moment a files-first app
   * BECOMES an app: the `authoredApp` seam is what upserts its row. Persisting
   * source before that would look for a row that does not exist yet.
   */
  it("runs AFTER the view — the app half is what makes the row it writes to", async () => {
    const inner = testWorkspace();
    const order: string[] = [];
    const workspace = wrapWorkspaceForRender(inner, {
      emit: () => order.push("view"),
      authoredApp: async () => {
        order.push("authored");
        return { data: {} };
      },
      commitSource: async () => {
        order.push("source");
      },
    });
    await workspace.writeFile(APP_VENDO, GOOD_APP);
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "a\n");
    await workspace.commit();
    expect(order.at(-1)).toBe("source");
    expect(order).toContain("authored");
  });
});

describe("the wrapper", () => {
  it("leaves every other filesystem operation untouched", async () => {
    const { workspace } = seam({ "/user/memory/a.md": "alpha" });
    await expect(workspace.readFile("/user/memory/a.md")).resolves.toBe("alpha");
    await expect(workspace.exists("/user/memory/a.md")).resolves.toBe(true);
    await workspace.mkdir("/user/files/deep", { recursive: true });
    await expect(workspace.exists("/user/files/deep")).resolves.toBe(true);
  });

  it("keeps commit reachable — the workspace is still a WorkspaceFs", async () => {
    const inner = testWorkspace();
    const workspace = wrapWorkspaceForRender(inner, { emit: () => undefined });
    await expect(workspace.commit({ message: "made the chart blue" })).resolves.toEqual({
      status: "ok",
      changed: [],
    });
    expect(inner.commits).toEqual([{ message: "made the chart blue", changed: [] }]);
  });
});
