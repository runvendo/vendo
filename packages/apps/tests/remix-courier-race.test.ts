/**
 * THE COURIER AND THE SAVE WRITE THE SAME ROW, so one of them must go second.
 *
 * A save asserts the row is still byte-identical to the baseline it computed
 * over and REFUSES otherwise (`assertCurrent`, doors/write-surface.ts) —
 * correctly, because a document computed over a stale row would revert the edit
 * that landed there. The live-props courier writes `seed.props` onto that same
 * row (`courierProps`, remix/seed-surface.ts), and it is not an edit at all: the
 * person did not change their remix, their page did. So a courier that arrives
 * inside a save's baseline-read→put window fails a save it has no quarrel with,
 * and the ✦ mint it lands in reports `app changed under this save`.
 *
 * In life that is a coin toss — the wrapper couriers as soon as discovery finds
 * the freshly minted row, which is squarely inside the build. Here it is not: the
 * save is PARKED on its baseline read, the courier is run against the parked row,
 * and only then is the save let go. Same interleaving every run.
 *
 * NEITHER SIDE IS STUBBED. The save is the real `authoredScreen` door every
 * screen lands through, the courier is the real `seed.props` door the wrapper
 * POSTs to, and both write the real store.
 *
 * The one that must be able to fail: take the ordering back off either door and
 * the courier's write lands in the window again — the save is refused, the
 * person's screen is the one they did not save, and the log says
 * `app changed under this save`.
 */
import { engineOverAdapter, type AppId, type RunContext, type ToolRegistry } from "@vendoai/core";
import { SCREEN_FILE, type AppDocument } from "../src/contract/index.js";
import { describe, expect, it, vi } from "vitest";
import { createApps, type SeedBaseline } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { FIXTURE_SCREEN, screenDocument } from "../src/server/testing/screen-document.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";

const APP_ID = "app_courier_race" as AppId;
const SLOT = "NetWorthView";

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

/** What the host's page is really rendering, and the decoy riding beside it. The
 *  baseline declares `valueCents` and nothing else, so the ordering must not buy
 *  the decoy a way in. */
const LIVE_CENTS = 14_292_930;
const DECOY = "must-not-cross";

const baseline: SeedBaseline = {
  slot: SLOT,
  source: "export default function NetWorthView() { return <p>net worth</p>; }\n",
  hash: "sha256:net-worth-view-1",
  exportable: false,
  capturedAt: "2026-08-18T09:00:00.000Z",
  sampleProps: { valueCents: 5_490_715 },
  // A baseline the splitter could not port has no remix to courier props to, so
  // the courier refuses at the lookup before any of this is reachable.
  ported: { source: FIXTURE_SCREEN, tools: [], holes: [] },
};

/** The screen the person saves while the courier is in the air — a different
 *  export name, so the save is a real change rather than the no-op an unchanged
 *  source short-circuits into. */
const SAVED = `import { Stack, Text } from "@vendo/screen";

export default function Renamed() {
  return (
    <Stack gap={12}>
      <Text text="Ready" variant="heading" />
    </Stack>
  );
}
`;

const deferred = (): { promise: Promise<void>; settle: () => void } => {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => { settle = resolve; });
  return { promise, settle };
};

const stand = () => {
  const store = memoryStore();
  let parked: { reached: () => void; hold: Promise<void> } | undefined;
  // The runtime reaches its app rows through this door, so a test can hold one
  // read open and know exactly what is standing in the window behind it.
  const wrapped = {
    ...store,
    records: (collection: string) => {
      const records = store.records(collection);
      if (collection !== "vendo_apps") return records;
      return {
        ...records,
        async get(id: string) {
          const record = await records.get(id);
          if (parked !== undefined) {
            const { reached, hold } = parked;
            parked = undefined;
            reached();
            await hold;
          }
          return record;
        },
      };
    },
  };
  const runtime = createApps({
    store: wrapped,
    guard: guardFixture(),
    tools,
    catalog: [],
    seedBaselines: [baseline],
  });
  return {
    runtime,
    store,
    /** Hold the NEXT app-row read open. `reached` resolves once a caller is
     *  parked on it; `release` lets that caller carry on. */
    parkNextRead: () => {
      const arrived = deferred();
      const held = deferred();
      parked = { reached: arrived.settle, hold: held.promise };
      return { reached: arrived.promise, release: held.settle };
    },
  };
};

/** Every chance the event loop can give the courier to land its write while the
 *  save is parked. Its read-modify-write is a handful of turns against an
 *  in-memory store, so this is orders of magnitude more room than it needs. Not
 *  a wall-clock budget and not a poll: once the two writers are ordered the
 *  courier simply waits here instead, which is the behaviour under test. */
const drain = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const docOf = async (store: ReturnType<typeof memoryStore>): Promise<AppDocument | undefined> => {
  const record = await store.records("vendo_apps").get(APP_ID);
  return (record?.data as { doc?: AppDocument } | null)?.doc;
};

describe("the live-props courier against a save already in flight", () => {
  it("lands the screen AND the props when it arrives inside the save's window", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { runtime, store, parkNextRead } = stand();
      await seedAppRow(engineOverAdapter(store), {
        ...screenDocument(APP_ID),
        seed: { component: SLOT, baseline: baseline.hash, wishes: ["track it monthly"] },
      }, "u1");

      // The save reads the row it is about to write over, and stops there.
      const { reached, release } = parkNextRead();
      const saving = runtime.authoredScreen({ appId: APP_ID, name: "Renamed", source: SAVED }, ctx);
      await reached;

      // The wrapper's courier, arriving exactly where it does in life: the save
      // has its baseline and has not yet asserted it.
      const couriered = runtime.seed.props(
        { appId: APP_ID, props: { valueCents: LIVE_CENTS, secretToken: DECOY } },
        ctx,
      );
      await drain();
      release();
      await saving;
      const answered = await couriered;

      // THE DEFECT: the courier's write used to land in the window, so the save
      // was refused and the person's screen was the one they did not save.
      expect(errors.mock.calls.map(String).join(" ")).not.toContain("app changed under this save");
      const stored = await docOf(store);
      expect(stored?.source?.[SCREEN_FILE]?.text).toBe(SAVED);

      // …and the provenance the courier carried is on the row too. Ordering the
      // two writers must not cost either one of them.
      expect(stored?.seed?.props).toEqual({ valueCents: LIVE_CENTS });
      expect(answered.seed?.props).toEqual({ valueCents: LIVE_CENTS });
      // The allowlist is the captured baseline's declared names, before and
      // after: the decoy is dropped at the door and never reaches the row.
      expect(JSON.stringify(stored)).not.toContain(DECOY);
    } finally {
      errors.mockRestore();
    }
  }, 30_000);
});
