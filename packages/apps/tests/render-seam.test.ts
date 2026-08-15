/**
 * Build contract §1.6, the hot-path render seam: every store write to the
 * hot-path file (`app.tsx`) that PAINTS makes the runtime emit today's
 * `data-vendo-view` part — same payload, same stable per-app stream id. A write
 * the checks floor refuses emits NOTHING and the last good view stays on screen.
 * Harnesses never yield view events; only this seam emits them.
 *
 * The store-write moment is `commit()`, not `writeFile` (orchestrator seam answer
 * after lane B landed): the façade stages writes in memory and
 * `CommitResult.changed` names exactly what reached the store. So every case here
 * writes AND commits, which is what the runtime makes happen for the harness.
 *
 * The floor is the REAL floor (`createAppFloor` — real esbuild, real tsc, the
 * real sealed VM), because the seam paints through `options.floor.component()`
 * and nothing else: a stubbed gauntlet here would be a seam agreeing with itself.
 */
import { vendoViewPartSchema, vendoViewStreamId, type AppId, type UIPayload, type VendoViewPart } from "@vendoai/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { warmScreenEngine } from "../src/contract/index.js";
import { createAppFloor } from "../src/server/checking/floor.js";
import { HOT_PATH_FILES, HOT_PATH_WATCH, hotPathAppId, paintedIn, viewForWrite, wrapWorkspaceForRender } from "../src/server/generation/render-seam.js";
import { testWorkspace } from "./test-doubles.test-util.js";

const APP = "app_1";
const APP_TSX = `/user/apps/${APP}/app.tsx`;

const GOOD_APP = `import { Stack, Text } from "@vendo/screen";

export default function Invoices() {
  return (
    <Stack gap={12}>
      <Text text="Hello" />
    </Stack>
  );
}
`;

/** The shipped floor, on a host with no tools and no components of its own —
 *  every screen here is Kit-only, which is what `screenCatalog` hands it. */
const floor = () => createAppFloor({
  deps: async () => ({ catalog: [], tools: [] }),
  runQuery: async () => ({}),
});

beforeAll(async () => {
  await warmScreenEngine();
});

function seam(files: Record<string, string> = {}) {
  const inner = testWorkspace(files);
  const emitted: Array<{ id: string; part: VendoViewPart }> = [];
  const workspace = wrapWorkspaceForRender(inner, {
    emit: (id, part) => emitted.push({ id, part }),
    floor: floor(),
  });
  /** Write then commit — what the runtime does for every in-process edit. */
  const save = async (path: string, content: string): Promise<void> => {
    await workspace.writeFile(path, content);
    await workspace.commit();
  };
  return { workspace, inner, emitted, save };
}

describe("hot paths", () => {
  it("is exactly app.tsx (§1.6)", () => {
    expect([...HOT_PATH_FILES]).toEqual(["app.tsx"]);
  });

  it("reads the appId out of the frozen §3.1 layout, verbatim", () => {
    expect(hotPathAppId("/user/apps/app_42/app.tsx")).toBe("app_42");
    expect(hotPathAppId("/orgs/acme/apps/app_42/app.tsx")).toBe("app_42");
  });

  it("refuses paths outside the frozen layout", () => {
    expect(hotPathAppId("/user/apps/app_1/notes.md")).toBeUndefined();
    expect(hotPathAppId("/user/memory/app.tsx")).toBeUndefined();
    expect(hotPathAppId("/user/scratch/app_1/app.tsx")).toBeUndefined();
    // Not an appId the store would ever mint.
    expect(hotPathAppId("/user/apps/nope/app.tsx")).toBeUndefined();
  });

  it("watches BOTH mounts — a team app's screen has to paint mid-turn too", () => {
    expect([...HOT_PATH_WATCH]).toEqual([
      "/user/apps/*/app.tsx",
      "/orgs/*/apps/*/app.tsx",
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
    await workspace.writeFile(APP_TSX, GOOD_APP);
    expect(emitted).toHaveLength(0);
  });

  it("the commit that lands it is what emits", async () => {
    const { workspace, emitted } = seam();
    await workspace.writeFile(APP_TSX, GOOD_APP);
    await workspace.commit();
    expect(emitted).toHaveLength(1);
  });

  it("a conflicted commit emits nothing — the last good view stays on screen", async () => {
    const { workspace, inner, emitted } = seam();
    await workspace.writeFile(APP_TSX, GOOD_APP);
    inner.conflictOn = [APP_TSX];
    await expect(workspace.commit()).resolves.toEqual({ status: "conflict", paths: [APP_TSX] });
    expect(emitted).toHaveLength(0);
  });

  it("emits only for the hot paths in `changed`, not for every path committed", async () => {
    const { workspace, emitted } = seam();
    await workspace.writeFile("/user/memory/notes.md", "some notes");
    await workspace.writeFile(APP_TSX, GOOD_APP);
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

describe("a painting save to app.tsx", () => {
  it("emits data-vendo-view on the stable per-app stream id", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, GOOD_APP);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.id).toBe(vendoViewStreamId(APP));
    expect(emitted[0]!.part.type).toBe("data-vendo-view");
    expect(emitted[0]!.part.appId).toBe(APP);
  });

  it("emits a payload today's renderer accepts (assembled tree)", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, GOOD_APP);
    const parsed = vendoViewPartSchema.safeParse(emitted[0]!.part);
    expect(parsed.success).toBe(true);
    const payload = emitted[0]!.part.payload as UIPayload & { root: string; nodes: unknown[] };
    expect(payload.root).toBe("root");
    expect(payload.nodes.length).toBeGreaterThan(0);
  });

  it("strips the server-authoritative fields the client must never be told", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, GOOD_APP);
    const serialized = JSON.stringify(emitted[0]!.part.payload);
    expect(serialized).not.toContain("inClient");
    expect(serialized).not.toContain("pinDrift");
  });

  it("emits again on every save — granularity is per file save", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, GOOD_APP);
    await save(APP_TSX, GOOD_APP.replace("Hello", "Goodbye"));
    expect(emitted).toHaveLength(2);
    expect(emitted.every((entry) => entry.id === vendoViewStreamId(APP))).toBe(true);
  });

  it("SETTLES the paint — a finished app must leave \"Building your view…\"", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, GOOD_APP);
    // Stamped streaming, the renderer holds the forming skeleton forever: no
    // verdict, no settle-scroll, no pin affordance. The gauntlet has already run
    // its queries, so this paint is FINAL.
    expect((emitted[0]!.part.payload as { streaming?: boolean }).streaming).toBe(false);
  });

  it("names the app it painted on the commit, so the hand that wrote it can tell", async () => {
    // `emit` belongs to whoever wrapped the workspace, so a writer who saved a
    // screen has no other way to learn whether it reached a surface — and a
    // refused screen leaves no row for `validate({appId})` to judge either.
    const { workspace } = seam();
    await workspace.writeFile(APP_TSX, GOOD_APP);
    expect(paintedIn(await workspace.commit())).toEqual([APP]);

    await workspace.writeFile(APP_TSX, "just some prose, no components at all");
    expect(paintedIn(await workspace.commit())).toEqual([]);
  });

  it("emits for appendFile too — the seam is the commit, not the write method", async () => {
    const { workspace, emitted } = seam({ [APP_TSX]: "" });
    await workspace.appendFile(APP_TSX, GOOD_APP);
    await workspace.commit();
    expect(emitted).toHaveLength(1);
  });
});

describe("a save the floor refuses", () => {
  it("emits nothing, so the last good view stays on screen", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, GOOD_APP);
    expect(emitted).toHaveLength(1);
    // Not a screen at all: the brokenness reaches the harness through
    // `validate`, never the user.
    await save(APP_TSX, "just some prose, no components at all");
    expect(emitted).toHaveLength(1);
  });

  it("emits nothing for an empty file", async () => {
    const { emitted, save } = seam();
    await save(APP_TSX, "");
    expect(emitted).toHaveLength(0);
  });

  it("still lands the write — the seam never swallows a store write", async () => {
    const { workspace, inner, save } = seam();
    await save(APP_TSX, "not a screen");
    await expect(workspace.readFile(APP_TSX)).resolves.toBe("not a screen");
    expect(inner.commits.at(-1)?.changed).toEqual([APP_TSX]);
  });

  it("says WHY, in the gauntlet's own sentences, so an operator can read it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { save } = seam();
      await save(APP_TSX, "just some prose, no components at all");
      const text = logged.mock.calls.map(String).join("\n");
      expect(text).toContain("did not pass the checks floor");
      expect(text).toContain("does not compile as TSX");
    } finally {
      logged.mockRestore();
    }
  });

  it("a failing emit never fails the commit", async () => {
    const workspace = wrapWorkspaceForRender(testWorkspace(), {
      emit: () => {
        throw new Error("the writer is gone");
      },
      floor: floor(),
    });
    await workspace.writeFile(APP_TSX, GOOD_APP);
    await expect(workspace.commit()).resolves.toMatchObject({ status: "ok" });
    await expect(workspace.readFile(APP_TSX)).resolves.toBe(GOOD_APP);
  });

  it("paints nothing at all when no floor is wired — a build with no screen engine", async () => {
    const workspace = wrapWorkspaceForRender(testWorkspace(), { emit: () => undefined });
    await workspace.writeFile(APP_TSX, GOOD_APP);
    const result = await workspace.commit();
    expect(paintedIn(result)).toEqual([]);
  });
});

describe("saves that are not hot paths", () => {
  it("emit nothing", async () => {
    const { emitted, save } = seam();
    await save("/user/memory/notes.md", GOOD_APP);
    await save(`/user/apps/${APP}/README.md`, GOOD_APP);
    await save("/user/scratch/draft.tsx", GOOD_APP);
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
 * `commitApp` had zero production callers and every built app's code lived only
 * inside its sandbox snapshot.
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
   * load-bearing one — the paint is the moment a files-first app BECOMES an app:
   * the gauntlet's own `ok` is what upserts its row (`AppFloor.component` →
   * `authoredScreen`). Persisting source before that would look for a row that
   * does not exist yet.
   */
  it("runs AFTER the view — the paint is what makes the row it writes to", async () => {
    const inner = testWorkspace();
    const order: string[] = [];
    const painting = createAppFloor({
      deps: async () => ({ catalog: [], tools: [] }),
      runQuery: async () => ({}),
      delivered: async () => { order.push("row"); },
    });
    const workspace = wrapWorkspaceForRender(inner, {
      emit: () => order.push("view"),
      floor: painting,
      commitSource: async () => {
        order.push("source");
      },
    });
    await workspace.writeFile(APP_TSX, GOOD_APP);
    await workspace.writeFile(`/user/apps/${APP}/src/App.tsx`, "a\n");
    await workspace.commit();
    expect(order).toEqual(["row", "view", "source"]);
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

// The block below moved here with the seam from `@vendoai/harnesses`' parity
// suite (H4 there): it exercises the seam alone, and the seam lives in this
// package now.

describe("the seam's payload settles", () => {
  const OTHER_TSX = "/user/apps/app_5/app.tsx";

  it("settles the finished paint, so the app leaves \"building\" and can reach a verdict", async () => {
    const view = await viewForWrite(OTHER_TSX, GOOD_APP, { emit: () => undefined, floor: floor() });
    expect((view?.part.payload as { streaming?: boolean }).streaming).toBe(false);
  });

  it("carries what the renderer re-boots the screen from", async () => {
    // The gauntlet already ran the screen's queries, so the paint is final — and
    // the compiled screen and its answers ride along, which is what makes the
    // emitted view a LIVE screen rather than a snapshot of one.
    const view = await viewForWrite(OTHER_TSX, GOOD_APP, { emit: () => undefined, floor: floor() });
    const interactive = (view?.part.payload as { interactive?: { compiledSource?: string } }).interactive;
    expect(interactive?.compiledSource).toContain("require(");
  });
});

describe("the seam wrapper survives a real façade", () => {
  it("does not break a class that uses private fields", async () => {
    class PrivateFieldFs {
      #files = new Map<string, string>();
      #staged = new Set<string>();
      async writeFile(path: string, content: string): Promise<void> {
        this.#files.set(path, content);
        this.#staged.add(path);
      }
      async readFile(path: string): Promise<string> {
        const found = this.#files.get(path);
        if (found === undefined) throw new Error("ENOENT");
        return found;
      }
      async commit(): Promise<{ status: "ok"; changed: string[] }> {
        const changed = [...this.#staged];
        this.#staged.clear();
        return { status: "ok", changed };
      }
    }
    const emitted: string[] = [];
    const workspace = wrapWorkspaceForRender(new PrivateFieldFs() as never, {
      emit: (id) => emitted.push(id),
      floor: floor(),
    });
    // `this` must be the real object, or every one of these throws
    // "Cannot read private member from an object whose class did not declare it".
    await workspace.writeFile("/user/apps/app_5/app.tsx", GOOD_APP);
    await expect(workspace.commit()).resolves.toMatchObject({ status: "ok" });
    expect(emitted).toEqual([vendoViewStreamId("app_5" as AppId)]);
  });
});
