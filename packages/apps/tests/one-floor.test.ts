/**
 * ONE floor at every door.
 *
 * Two doors let an app reach a screen — the paint seam's floor
 * (`AppsRuntime.floor`, which composition hands the render seam) and
 * `validate({ appId })` — and each ran a different subset of the checks. A screen
 * that crashes the moment it renders was caught at exactly one of them: the
 * stored-app door shipped the same broken screen without ever executing it.
 *
 * There WERE more doors. Until "the brain dies" (9a3e81342) an edit ran a
 * validator of its own (`documentFromEdit`); since then an edit is the screen
 * assembler opening the app's own `app.tsx`, rewriting it and saving it, so the
 * save is checked by the paint seam's floor below and by nothing else. That
 * validator sat callerless and is deleted, and with it its carried-issue filter —
 * an edit excused for a stale node the previous version already carried — which
 * production has never had on this architecture: a block is a block, from every
 * author, on every commit (`../src/server/generation/render-seam.ts`).
 * `validate({ document })` is gone too: an app is a stored screen now, so there is
 * no loose text to judge.
 *
 * These drive one deliberately-broken screen through both doors, each through its
 * own real entry point, and assert the SAME refusal at every one. Nothing here
 * stubs a check: the floor is the shipped floor, the store is a real store, and
 * the screen really renders (and really crashes) in the sealed VM.
 */
import {
  type AppId,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type NormalizedCatalog,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";

/** Renders once, reaches through a value nothing is behind, and takes the whole
 *  screen down with it. It passes ADMISSION — valid TSX, only the screen module
 *  imported, no DOM — and it type-checks, so only the render stage can see it. */
const CRASHING_SCREEN = `import { Stack, Text } from "@vendo/screen";

const totals = undefined as unknown as { spend: number };

export default function Broken() {
  return (
    <Stack>
      <Text text={String(totals.spend)} />
    </Stack>
  );
}
`;

const HEALTHY_SCREEN = `import { Stack, Text } from "@vendo/screen";

export default function Broken() {
  return (
    <Stack>
      <Text text="steady" />
    </Stack>
  );
}
`;

const CRASH = /threw while rendering/;

const catalog: NormalizedCatalog = [];

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

/** A model that answers nothing useful: every door under test here is
 *  deterministic, and the reviewer is fail-open by design. */
const model = () => scriptedLanguageModel(() => "no");

const runtime = () =>
  createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog, model: model() });

describe("a crashing screen is refused at every door", () => {
  it("the paint seam, which is where an edit's save lands too", async () => {
    // `AppsRuntime.floor(ctx)` verbatim — the object `packages/vendo` passes to
    // the render seam that wraps the screen assembler's workspace, so this is
    // the door for a files-first save, a `vendo_make` create AND an edit.
    const floor = runtime().floor(ctx);

    const painted = await floor.component({ appId: "app_one_floor" as AppId, source: CRASHING_SCREEN });

    expect(painted.ok).toBe(false);
    expect((painted as { blocking: readonly string[] }).blocking.join("\n")).toMatch(CRASH);
  }, 60_000);

  it("validate({ appId })", async () => {
    const apps = createApps({ store: memoryStore(), guard: guardFixture(), tools, catalog, model: model() });
    // Stored through the door that stores screens, because a refused paint leaves
    // no row: an app whose screen went bad after it landed — the host's data moved
    // under it, or it predates a stage — is exactly what this door is asked about.
    await apps.authoredScreen({ appId: "app_stored_broken" as AppId, name: "Broken", source: CRASHING_SCREEN }, ctx);

    const result = await apps.validate({ appId: "app_stored_broken" as AppId }, ctx);

    expect(result.ok).toBe(false);
    expect(result.findings.map(({ message }) => message).join("\n")).toMatch(CRASH);
  }, 60_000);
});

describe("the floor still lets a sound screen through every door", () => {
  it("the paint seam paints it, and validate({ appId }) passes the row it left", async () => {
    const apps = runtime();

    // A paint is what CREATES the row, so one save feeds both doors.
    const painted = await apps.floor(ctx).component({ appId: "app_one_floor_ok" as AppId, source: HEALTHY_SCREEN });

    expect(painted.ok).toBe(true);
    expect((await apps.validate({ appId: "app_one_floor_ok" as AppId }, ctx)).ok).toBe(true);
  }, 60_000);
});
