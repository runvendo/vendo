/**
 * THE ✦ MINT MUST NOT REVERT THE PROPS THE COURIER JUST DELIVERED.
 *
 * `seedFrom` twice reads the app row and then puts a WHOLE document computed
 * over that read — putting the mint's name back after the port's paint renamed
 * the app (`remix/seed-surface.ts`), and marking a failed build over the row as
 * it stands. Neither read-modify-write took a turn on the row, so the courier —
 * which writes `seed.props` whenever the host re-renders, and re-renders all the
 * way through a mint — could land its write BETWEEN one of those reads and its
 * put, and the put would carry the pre-courier document back over it.
 *
 * That is a LOST UPDATE, not the mint failure #1565 fixed: nothing is refused
 * and nothing is logged. The remix simply stops following the host page and goes
 * back to showing the values captured the day `vendo sync` ran, which is the one
 * promise the courier exists to keep.
 *
 * DETERMINISTIC, NOT PROBABILISTIC. A read of the app row is held open, the
 * courier is run to completion against the parked row, and only then is the
 * reader let go — the same shape `remix-courier-race.test.ts` uses for the
 * adjacent race. Rather than hunt for the two reads by name, the mint is first
 * run once to count the reads it takes, and then re-run parked at every one of
 * them in turn: the courier lands in every window the mint has, so a blind put
 * added here later is caught the day it is written. Same interleaving every run.
 *
 * NEITHER SIDE IS STUBBED. The mint is the real ✦ door, the courier is the real
 * `seed.props` door the wrapper POSTs to, and both write the real store.
 */
import type { RunContext, StoreAdapter, ToolRegistry } from "@vendoai/core";
import { type AppDocument, type SeedBaseline } from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { FIXTURE_SCREEN } from "../src/server/testing/screen-document.js";

const SLOT = "net-worth-card";

/** What the host's page is really rendering, and the decoy riding beside it. The
 *  baseline declares `valueCents` and nothing else, so ordering the writers must
 *  not buy the decoy a way in. */
const LIVE_CENTS = 14_292_930;
const DECOY = "must-not-cross";

const ctx: RunContext = {
  principal: { kind: "user", subject: "u1" },
  venue: "app",
  presence: "present",
  sessionId: "s1",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "missing" } }; },
};

const baseline: SeedBaseline = {
  slot: SLOT,
  source: "export default function NetWorthCard() {\n  return <strong>$1.2M</strong>;\n}",
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sampleProps: { valueCents: 120_000_000 },
  ported: { source: FIXTURE_SCREEN, tools: [], holes: [] },
};

const deferred = (): { promise: Promise<void>; settle: () => void } => {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, settle };
};

/**
 * A runtime whose app-row reads can be held open, one chosen read at a time.
 *
 * No screen agent is wired, so the instruction the ✦ carries cannot be built and
 * the mint takes its failure-marker path — which is the shortest run that passes
 * through BOTH of the puts under test, the paint's name restore and the marker
 * itself.
 */
const stand = (parkAt = 0) => {
  const store = memoryStore();
  const arrived = deferred();
  const held = deferred();
  let reads = 0;
  let appId: string | undefined;
  const wrapped: StoreAdapter = {
    ...store,
    records: (collection: string) => {
      const records = store.records(collection);
      if (collection !== "vendo_apps") return records;
      return {
        ...records,
        async get(id: string) {
          const record = await records.get(id);
          appId ??= id;
          reads += 1;
          if (reads === parkAt) {
            arrived.settle();
            await held.promise;
          }
          return record;
        },
      };
    },
  };
  return {
    runtime: createApps({
      store: wrapped,
      guard: guardFixture(),
      tools,
      catalog: [],
      seedBaselines: [baseline],
    }),
    store,
    reads: () => reads,
    /** The row the mint just created, learned from the first read of it. */
    appId: () => appId as AppDocument["id"],
    /** Resolves once a reader is parked on read `parkAt`. */
    reached: arrived.promise,
    /** Lets that reader carry on. */
    release: held.settle,
  };
};

/** Every chance the event loop can give the courier to land its write while a
 *  read is parked. Its read-modify-write is a handful of turns against an
 *  in-memory store, so this is orders of magnitude more room than it needs. Not
 *  a wall-clock budget and not a poll: once the writers are ordered the courier
 *  simply waits here instead, which is the behaviour under test. */
const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const docOf = async (
  store: ReturnType<typeof memoryStore>,
  appId: string,
): Promise<AppDocument | undefined> => {
  const record = await store.records("vendo_apps").get(appId);
  return (record?.data as { doc?: AppDocument } | null)?.doc;
};

describe("the live-props courier against a ✦ mint already in flight", () => {
  it("keeps the props it delivered, wherever in the mint they land", async () => {
    // How many reads of the app row one mint takes — counted rather than
    // assumed, so the sweep below covers every window this door really has.
    const counting = stand();
    await counting.runtime.seed.from({ component: SLOT, instruction: "make it blue" }, ctx);
    const reads = counting.reads();
    expect(reads).toBeGreaterThan(0);

    for (let at = 1; at <= reads; at += 1) {
      const { runtime, store, appId, reached, release } = stand(at);
      const minting = runtime.seed.from({ component: SLOT, instruction: "make it blue" }, ctx);
      await reached;

      // The wrapper's courier, arriving exactly where it does in life: somewhere
      // inside the build of the row discovery has just found.
      const couriered = runtime.seed.props(
        { appId: appId(), props: { valueCents: LIVE_CENTS, secretToken: DECOY } },
        ctx,
      );
      await drain();
      release();
      await minting;
      await couriered;

      // THE DEFECT: a put computed over the pre-courier read carried the old
      // document back over the row, and the remix silently went back to the
      // baseline's captured values with nothing refused and nothing logged.
      const stored = await docOf(store, appId());
      expect(stored?.seed?.props, `courier parked at read ${at} of ${reads}`)
        .toEqual({ valueCents: LIVE_CENTS });
      // The allowlist is the captured baseline's declared names, before and
      // after: the decoy is dropped at the door and never reaches the row.
      expect(JSON.stringify(stored)).not.toContain(DECOY);
    }
  }, 60_000);
});
