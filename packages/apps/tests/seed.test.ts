import { engineOverAdapter } from "@vendoai/core";
/**
 * Remix as a seeded app (06-apps §8).
 *
 * A remix is not a subsystem: it is a create that starts from something that
 * already existed. After the re-platform it is also not a COPY — the ✦ gesture
 * collects an instruction, records where the remix came from, and runs that
 * instruction through the ordinary edit door. What lands is an ordinary screen
 * app (`app.tsx`, the same artifact every other screen is), so there is no
 * captured host source in the document and nothing evaluates any.
 *
 * That single fact retires the two proofs this file used to carry — the island
 * gate's by-name exemption for a seeded seat, and the seat holding its own jail
 * furnishings. Both existed to make the host's own bytes runnable inside a
 * remix. Nothing runs them now, so what is asserted below is that nothing
 * carries them either.
 */
import {
  VENDO_APP_FORMAT,
  type Json,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  SCREEN_FILE,
  seedDrift,
  type AppDocument,
  type SeedBaseline,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { scriptedScreenAssembler } from "../src/server/testing/screen-assembler.js";
import { FIXTURE_SCREEN } from "../src/server/testing/screen-document.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { basicLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const owner: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no fixture tools" } }; },
};

const SLOT = "net-worth-card";
const SOURCE = `// Host provenance comment nothing may copy into the remix.
export default function NetWorthCard() {
  return <strong>$1.2M</strong>;
}`;

const baseline = (hash = "sha256:maple-base"): SeedBaseline => ({
  slot: SLOT,
  source: SOURCE,
  hash,
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sourceImports: { "./format-currency": "src/format-currency.ts" },
  subSources: { "src/format-currency.ts": { source: "export const money = 1;", imports: {} } },
  sampleProps: { valueCents: 120_000_000 },
  styles: [{ path: "src/app.css", css: ".host { color: rebeccapurple; }" }],
  // The splitter's half — the ported source the ✦ seeds as the app's own
  // `app.tsx`. Deliberately shares not one byte with `SOURCE` above, so the
  // "nothing of the capture reaches the remix" assertions still mean what they
  // say: the PORT travels, the raw capture never does.
  ported: { source: FIXTURE_SCREEN, tools: [], holes: [] },
});

/** The ONE builder, as a fixture: it writes `app.tsx` and lands it through
 *  `authoredScreen`. The screen quotes the ask, so the person's own words are
 *  visible in the stored artifact. */
const askedScreen = (runtime: () => AppsRuntime, seen: string[] = []) =>
  scriptedScreenAssembler(runtime, (request) => {
    seen.push(request.request);
    return `export default function Screen() {\n  return <b>${request.request}</b>;\n}\n`;
  });

/** The wish the host's NEW version has nothing to change, so its replay refuses. */
const REFUSED = "paint the total purple";

/** The same builder, except that one wish no longer applies. */
const refusingScreen = (runtime: () => AppsRuntime) =>
  scriptedScreenAssembler(runtime, (request) =>
    // The edit door leads its brief with the app's memory, so the wish being
    // replayed is the last line of the request.
    request.request.endsWith(REFUSED)
      ? { kind: "unavailable", why: "the new version has no total to paint" }
      : `export default function Screen() {\n  return <b>replayed</b>;\n}\n`);

const runtimeWith = (store: ReturnType<typeof memoryStore>, overrides: Partial<AppsConfig> = {}) => createApps({
  store,
  guard: guardFixture(),
  tools,
  catalog: [],
  seedBaselines: [baseline()],
  ...overrides,
});

/** A runtime with the builder wired, and the asks it was handed. */
const buildingRuntime = (store: ReturnType<typeof memoryStore>, overrides: Partial<AppsConfig> = {}) => {
  const asked: string[] = [];
  let runtime: AppsRuntime;
  runtime = runtimeWith(store, {
    model: basicLanguageModel(),
    screen: askedScreen(() => runtime, asked),
    ...overrides,
  });
  return { runtime, asked };
};

// ---------------------------------------------------------------------------
// The ✦ gesture: an instruction, then an ordinary screen carrying provenance.
// ---------------------------------------------------------------------------

describe("seed.from — the ✦ gesture is a create that starts from something", () => {
  it("mints an ordinary screen app and records what was asked for", async () => {
    const { runtime, asked } = buildingRuntime(memoryStore());

    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);

    // Provenance is ONE record on the document, not a row set — and it opens the
    // wish list, because a re-seed replays every entry of it.
    expect(app.seed).toEqual({
      component: SLOT,
      baseline: "sha256:maple-base",
      wishes: ["add a sparkline"],
    });
    // The remix IS its screen: the ordinary artifact, through the ordinary door.
    expect(app.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
    expect(asked).toEqual(["add a sparkline"]);
    // And not one byte of the host's capture rode along — no seat, no bundle, no
    // jail furnishings.
    expect(app.components).toBeUndefined();
    expect(JSON.stringify(app)).not.toContain("Host provenance comment");
    expect(JSON.stringify(app)).not.toContain("rebeccapurple");
  });

  it("refuses a component the host never captured", async () => {
    const runtime = runtimeWith(memoryStore());
    await expect(runtime.seed.from({ component: "never-synced", instruction: "add a sparkline" }, owner))
      .rejects.toThrow(/no captured baseline/);
  });

  /**
   * THE PROPS SLOT, at the seed door. A port whose paint depends on a prop
   * renders nothing without one — the host's own mid-stream guard — and the
   * floor grades it with the BASELINE's own sampleProps, the same captured
   * values sync graded it with. Both directions pinned: with the sampleProps
   * the seed lands; without them the gesture refuses loudly instead of
   * minting a remix that opens blank.
   */
  const PROPPED_PORT = `export default function StatCard({ total }: { total?: number }) {
  if (total === undefined) return null;
  return <section><p>{total}</p></section>;
}
`;
  const proppedBaseline = (sampleProps?: Record<string, Json>): SeedBaseline => ({
    ...baseline(),
    ported: { source: PROPPED_PORT, tools: [], holes: [] },
    ...(sampleProps === undefined ? {} : { sampleProps }),
  });

  it("paints a props-dependent port with the baseline's own sampleProps", async () => {
    const { runtime } = buildingRuntime(memoryStore(), { seedBaselines: [proppedBaseline({ total: 7 })] });
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    expect(app.seed?.component).toBe(SLOT);
    expect(app.buildFailed).toBeUndefined();
  });

  it("refuses the same port loudly when the baseline captured no sampleProps", async () => {
    const { runtime } = buildingRuntime(memoryStore(), { seedBaselines: [proppedBaseline()] });
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    expect(app.buildFailed?.reason).toContain("painted nothing");
  });
});

// ---------------------------------------------------------------------------
// Drift is a WARNING. Never automatic.
// ---------------------------------------------------------------------------

describe("seed drift — a warning, never an action", () => {
  it("reports drift when the host component moves on, and nothing changes on its own", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );

    // The host re-syncs: same slot, new capture.
    const resynced = runtimeWith(store, { seedBaselines: [baseline("sha256:maple-NEW")] });
    const drift = await resynced.seed.drift(app.id, owner);
    expect(drift).toMatchObject({
      component: SLOT,
      baseline: "sha256:maple-base",
      current: "sha256:maple-NEW",
      reason: "baseline-changed",
    });

    // Reporting drift did not touch the app: the person's remix is untouched
    // until they ask for the update.
    const after = await resynced.get(app.id, owner);
    expect(after?.seed?.baseline).toBe("sha256:maple-base");
    expect(after?.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
  });

  it("is silent on an app with no seed, and on one still at its baseline", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );
    expect(await runtimeWith(store).seed.drift(app.id, owner)).toBeNull();

    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_plain",
      name: "Authored",
      ui: "tree",
    };
    expect(seedDrift(plain, [baseline("sha256:whatever")])).toBeNull();
  });

  it("reports a missing baseline as its own reason", () => {
    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_seeded",
      name: "Seeded",
      ui: "tree",
      seed: { component: SLOT, baseline: "sha256:gone", wishes: ["add a sparkline"] },
    };
    expect(seedDrift(doc, [])).toMatchObject({ reason: "baseline-missing" });
    expect(seedDrift(doc, [])?.current).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The re-seed: the host shipped a new version, so run the recorded ask again.
// ---------------------------------------------------------------------------

describe("seed.reseed — the recorded instruction, replayed on the new baseline", () => {
  it("re-runs the ask the remix was made with and mints a version", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );

    const updated: SeedBaseline = {
      ...baseline("sha256:maple-NEW"),
      source: "export default function NetWorthCard() { return <strong>$1.4M</strong>; }",
    };
    const { runtime: resynced, asked } = buildingRuntime(store, { seedBaselines: [updated] });

    const reseeded = await resynced.seed.reseed({ appId: app.id }, owner);

    // The provenance moved, the wish list did not, and the builder ran it.
    expect(reseeded.seed).toEqual({
      component: SLOT,
      baseline: "sha256:maple-NEW",
      wishes: ["add a sparkline"],
    });
    expect(asked).toEqual(["add a sparkline"]);
    // The warning is gone because the app is now AT the current baseline.
    expect(await resynced.seed.drift(app.id, owner)).toBeNull();
    // It is an ordinary version in the ordinary history.
    const versions = await resynced.history(app.id, owner).list();
    expect(versions.some(({ intent }) => /Update .* to the host's current version/.test(intent))).toBe(true);
  });

  it("leaves the baseline where it was when the replay does not land", async () => {
    const store = memoryStore();
    const app = await buildingRuntime(store).runtime.seed.from(
      { component: SLOT, instruction: "add a sparkline" },
      owner,
    );

    // The host shipped a new version and the replay REFUSES. The edit door
    // reports that in `failure` rather than throwing, so rebasing the baseline
    // ahead of the replay left the OLD screen reading as the host's current
    // version — silently, with a 200 and no drift warning.
    const resynced = runtimeWith(store, {
      model: basicLanguageModel(),
      seedBaselines: [baseline("sha256:maple-NEW")],
      screen: { assemble: async () => ({ kind: "unavailable", why: "I could not write that change" }) },
    });

    const answer = await resynced.seed.reseed({ appId: app.id }, owner);

    expect(answer.seed?.baseline).toBe("sha256:maple-base");
    const stored = await resynced.get(app.id, owner);
    expect(stored?.seed?.baseline).toBe("sha256:maple-base");
    expect(stored?.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
    // So the warning still stands — and the retry is not refused as a conflict
    // against a baseline this remix never actually reached.
    expect(await resynced.seed.drift(app.id, owner)).toMatchObject({ reason: "baseline-changed" });
    const versions = await resynced.history(app.id, owner).list();
    expect(versions.some(({ intent }) => /host's current version/.test(intent))).toBe(false);
  });

  it("refuses a re-seed that would change nothing, and one on an unseeded app", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    await expect(runtime.seed.reseed({ appId: app.id }, owner)).rejects.toThrow(/has not changed/);

    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_unseeded",
      name: "Authored",
      ui: "tree",
    };
    await seedAppRow(engineOverAdapter(store), plain, owner.principal.subject);
    await expect(runtime.seed.reseed({ appId: plain.id }, owner))
      .rejects.toThrow(/was not created from a host component/);
  });
});

// ---------------------------------------------------------------------------
// THE SEAM: the seed carries the WHOLE wish list, so an update replays all of
// it. Every leg below is the shipped path — the ✦ door writes the first wish,
// the agent tool chat calls writes the rest, the store holds them, and the
// re-seed reads them back. Nothing on either side stands in for the other.
// ---------------------------------------------------------------------------

describe("the seed keeps EVERY wish, and a re-seed replays all of them in order", () => {
  it("appends each chat edit's wish and replays the whole list on the new baseline", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);

    // 1. WRITE, leg one — the ✦ gesture, through the real seed door.
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    // 2. WRITE, leg two — two more edits, through the real `vendo_make` tool the
    //    chat calls, on the real registry.
    const tools = runtime.agentTools();
    for (const request of ["make the number bigger", "put last month beside it"]) {
      expect(await tools.execute({ id: `call_${request}`, tool: "vendo_make", args: { app: app.id, request } }, owner))
        .toMatchObject({ status: "ok" });
    }
    // 3. READ — the stored row, through the ordinary read door.
    const WISHES = ["add a sparkline", "make the number bigger", "put last month beside it"];
    expect((await runtime.get(app.id, owner))?.seed?.wishes).toEqual(WISHES);

    // 4. The host ships a new version. The update replays ALL of them, oldest
    //    first — the remix is the whole list, never just the ask it started on.
    const { runtime: resynced, asked: replayed } = buildingRuntime(store, {
      seedBaselines: [baseline("sha256:maple-NEW")],
    });
    const reseeded = await resynced.seed.reseed({ appId: app.id }, owner);

    // The edit door leads each brief with the app's memory, so the wish itself
    // is the request's last line.
    expect(replayed.map((request) => request.split("\n").at(-1))).toEqual(WISHES);
    expect(reseeded.seed).toEqual({ component: SLOT, baseline: "sha256:maple-NEW", wishes: WISHES });
    expect((await resynced.get(app.id, owner))?.seed?.wishes).toEqual(WISHES);
  });

  it("surfaces a wish the new version cannot take instead of dropping it", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    expect(await runtime.agentTools().execute(
      { id: "call_colour", tool: "vendo_make", args: { app: app.id, request: REFUSED } },
      owner,
    )).toMatchObject({ status: "ok" });

    // The host's new version has nothing for the second wish to change.
    let resynced: AppsRuntime;
    resynced = runtimeWith(store, {
      model: basicLanguageModel(),
      seedBaselines: [baseline("sha256:maple-NEW")],
      screen: refusingScreen(() => resynced),
    });

    const outcome = await resynced.agentTools().execute(
      { id: "call_reseed", tool: "vendo_apps_reseed", args: { appId: app.id } },
      owner,
    );

    // SAID, in the chat that asked for the update — not swallowed. The `say` is
    // the sentence the agent utters verbatim, so the wish has to be IN it, not
    // merely somewhere in the document beside it.
    expect(outcome).toMatchObject({ status: "ok", output: { say: expect.stringContaining(REFUSED) } });
    // And KEPT: it is still a wish, so the next re-seed tries it again.
    const stored = await resynced.get(app.id, owner);
    expect(stored?.seed?.wishes).toEqual(["add a sparkline", REFUSED]);
    expect(stored?.seed?.unapplied).toEqual([REFUSED]);
    // The wish that DID land moved the app onto the host's new version.
    expect(stored?.seed?.baseline).toBe("sha256:maple-NEW");
  });

  it("reports EVERY wish when the new version can take none of them", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);
    const app = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    expect(await runtime.agentTools().execute(
      { id: "call_colour", tool: "vendo_make", args: { app: app.id, request: REFUSED } },
      owner,
    )).toMatchObject({ status: "ok" });

    // The host's new version can take NEITHER wish. This is the run with
    // nothing else to show for itself, so it is the run that most has to speak.
    const resynced = runtimeWith(store, {
      model: basicLanguageModel(),
      seedBaselines: [baseline("sha256:maple-NEW")],
      screen: { assemble: async () => ({ kind: "unavailable", why: "the new version has nothing to change" }) },
    });

    const outcome = await resynced.agentTools().execute(
      { id: "call_reseed", tool: "vendo_apps_reseed", args: { appId: app.id } },
      owner,
    );

    expect(outcome).toMatchObject({ status: "ok", output: { say: expect.stringContaining("add a sparkline") } });
    expect(outcome).toMatchObject({ output: { say: expect.stringContaining(REFUSED) } });
    const stored = await resynced.get(app.id, owner);
    expect(stored?.seed?.unapplied).toEqual(["add a sparkline", REFUSED]);
    // Nothing landed, so the remix is still on the version it was made against
    // and the warning stands for the retry.
    expect(stored?.seed?.baseline).toBe("sha256:maple-base");
    expect(await resynced.seed.drift(app.id, owner)).toMatchObject({ reason: "baseline-changed" });
  });
});

// ---------------------------------------------------------------------------
// THE ✦ ONE DOOR. The wrapper's ✦ mints nothing: it opens the chat prefilled
// ("Remix my <Slot>: ") and names the component in the conversation's context
// ("The view being remixed is the "<Slot>" component on the host's page."). So
// `vendo_make` is the only thing that can turn that wish into a REMIX, and if it
// mints an ordinary app instead the wrapper never finds it and the ✦ silently
// does nothing at all.
// ---------------------------------------------------------------------------

/** The wrapper's discovery rule, verbatim — `useRemixFork` in
 *  `packages/ui/src/chrome/remixable.tsx` reads `client.apps.list()` (the wire's
 *  `GET /apps`, which is `runtime.list()`) and takes the OLDEST app seeded from
 *  this component. If this returns undefined the ✦ did nothing. */
const discovered = (apps: AppDocument[], component: string): string | undefined =>
  apps.filter((app) => app.seed?.component === component).at(-1)?.id;

/** The call the agent makes after reading the ✦'s context fence. */
const remixCall = (id: string, request: string) =>
  ({ id, tool: "vendo_make", args: { request, component: SLOT } });

describe("the ✦ one door — a wish naming the host component becomes a remix", () => {
  it("mints a seeded app the wrapper discovers, carrying the wish already", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);

    const outcome = await runtime.agentTools().execute(remixCall("call_remix", "add a sparkline"), owner);

    expect(outcome).toMatchObject({ status: "ok" });
    // READ BACK through the ordinary list door — the one the wrapper polls.
    const appId = discovered(await runtime.list(owner), SLOT);
    expect(appId, "the wrapper must find the remix, or the ✦ did nothing").toBeDefined();
    const app = await runtime.get(appId!, owner);
    // Provenance the wrapper matches on, and the wish a re-seed replays.
    expect(app?.seed).toEqual({ component: SLOT, baseline: "sha256:maple-base", wishes: ["add a sparkline"] });
    // And it IS a screen, so there is something to mount in the original's place.
    expect(app?.source?.[SCREEN_FILE]?.text).toContain("add a sparkline");
  });

  it("lands a SECOND wish on the same remix instead of dropping it on the dedupe", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);
    const tools = runtime.agentTools();

    // The context fence stays in the thread, so a follow-up wish arrives named
    // the same way. The seed door dedupes per (subject, component) and drops the
    // riding instruction — this is the ONE door, so the wish must still land.
    await tools.execute(remixCall("call_first", "add a sparkline"), owner);
    const outcome = await tools.execute(remixCall("call_second", "make the number bigger"), owner);

    expect(outcome).toMatchObject({ status: "ok" });
    const seeded = (await runtime.list(owner)).filter(({ seed }) => seed?.component === SLOT);
    expect(seeded, "a second wish must not mint a second remix").toHaveLength(1);
    expect(seeded[0]?.seed?.wishes).toEqual(["add a sparkline", "make the number bigger"]);
  });

  it("lands a wish repeated VERBATIM as an edit rather than a silent no-op", async () => {
    const store = memoryStore();
    const { runtime, asked } = buildingRuntime(store);
    const tools = runtime.agentTools();

    await tools.execute(remixCall("call_first", "add a sparkline"), owner);
    // The SAME wish again. The seed door dedupes it onto the remix that exists,
    // which leaves that remix in exactly the state a fresh mint would be in —
    // so reading the wish list back to tell the two apart called the repeat new
    // and dropped it, on a receipt that said "ready".
    const outcome = await tools.execute(remixCall("call_again", "add a sparkline"), owner);

    expect(outcome).toMatchObject({ status: "ok" });
    const seeded = (await runtime.list(owner)).filter(({ seed }) => seed?.component === SLOT);
    expect(seeded, "a repeat must not mint a second remix").toHaveLength(1);
    expect(seeded[0]?.seed?.wishes).toEqual(["add a sparkline", "add a sparkline"]);
    // And it reached the builder, rather than being answered from the store.
    expect(asked).toHaveLength(2);
  });

  it("keeps BOTH wishes when two gestures race past the seed door's pre-mint check", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);
    const tools = runtime.agentTools();

    // Both find no remix, both mint, and the seed door resolves it afterwards:
    // the loser is handed the WINNER's app, with its own app — and the wish
    // riding it — deleted. So the loser's wish exists nowhere unless this door
    // lands it, and neither caller ever saw an app to recognise as pre-existing.
    const [first, second] = await Promise.all([
      tools.execute(remixCall("call_blue", "make it blue"), owner),
      tools.execute(remixCall("call_green", "make it green"), owner),
    ]);

    expect(first).toMatchObject({ status: "ok" });
    expect(second).toMatchObject({ status: "ok" });
    const seeded = (await runtime.list(owner)).filter(({ seed }) => seed?.component === SLOT);
    expect(seeded, "a race must not mint two remixes").toHaveLength(1);
    expect(seeded[0]?.seed?.wishes).toEqual(["make it blue", "make it green"]);
  });

  it("refuses a component the host never captured rather than minting an orphan", async () => {
    const { runtime } = buildingRuntime(memoryStore());

    const outcome = await runtime.agentTools().execute({
      id: "call_invented",
      tool: "vendo_make",
      args: { request: "add a sparkline", component: "invented-by-the-model" },
    }, owner);

    // The captured baselines ARE the allowlist: an id nothing captured names no
    // component on the page, so nothing is minted and the model is told why.
    expect(outcome).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(await runtime.list(owner)).toHaveLength(0);
  });
});

describe("seed.from is idempotent per (subject, component)", () => {
  it("a double tap returns the SAME app instead of minting a second", async () => {
    const store = memoryStore();
    const { runtime } = buildingRuntime(store);

    const first = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);
    const second = await runtime.seed.from({ component: SLOT, instruction: "add a sparkline" }, owner);

    expect(second.id).toBe(first.id);
    expect((await runtime.list(owner)).filter(({ seed }) => seed?.component === SLOT)).toHaveLength(1);
  });
});
