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
import { vendoViewPartSchema, vendoViewStreamId, type VendoViewPart } from "@vendoai/core";
import { describe, expect, it } from "vitest";
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
    await save(
      PLAN_VENDO,
      `<Plan name="Invoices">
  <Group title="Unpaid">
    <Leaf component="Table" />
  </Group>
</Plan>`,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.id).toBe(vendoViewStreamId(APP));
    const payload = emitted[0]!.part.payload as { nodes: unknown[] };
    expect(payload.nodes.length).toBeGreaterThan(0);
  });

  it("emits nothing for a plan that does not parse", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, "there is no plan document here");
    expect(emitted).toHaveLength(0);
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
