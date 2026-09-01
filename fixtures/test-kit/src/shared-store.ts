/** One PGlite store per test FILE, handed back with everything a test wrote wiped.
 *
 *  The fixture suites' `createStack()` used to boot a file-backed PGlite engine
 *  per call — ~700ms of boot and migrations to prepare a database the stack then
 *  wrote a handful of rows into, across 118 call sites in four suites. Emptying
 *  an already-booted one gives the same starting state (schema present, no rows)
 *  in tens of milliseconds, so the boot is paid once per file instead of once
 *  per stack: 148s of measured test time became 58s.
 *
 *  This is `packages/vendo/src/store/backends.test-util.ts`'s `emptySharedStore`,
 *  re-implemented rather than imported: that one lives in vendo's `src/` and is
 *  not in the published `dist`, and the fixtures consume `@vendoai/vendo` as a
 *  built workspace dependency with no source alias. Change one, look at the
 *  other — they are the same reset and the same rules, with its own contract
 *  test next door.
 *
 *  ONE deliberate difference: vendo's version also keys the engine map on a
 *  `StoreConfig` (its `encryption` option), because a store's encryption key is
 *  fixed at construction and two keys cannot share a handle. No fixture stack
 *  configures encryption, so this map is keyed on the engine NAME alone. Add the
 *  config half here the day a fixture needs it, or two stores with different
 *  keys will silently be one.
 *
 *  Per FILE, never across files. Vitest's isolated forks re-evaluate the module
 *  graph for each test file, so the map below — and the engines it holds — die
 *  with the file. That is what keeps the suites' shared subject constants (`ADA`,
 *  `BOB`) safe: a bare `SELECT ... toHaveLength(1)` is only order-dependent once
 *  two FILES can write to one database, and they cannot.
 *
 *  ONE HANDLE per engine, not one per call: `memory://` data dirs are private to
 *  their handle (store/db.ts), so callers on the same engine share a store, not
 *  just a database. Do not close it — `close()` on a stack that borrowed one must
 *  leave it open for the next test in the file. A test that needs two stores at
 *  once that are genuinely independent must NAME the second engine; two unnamed
 *  calls are the same store twice and would make an isolation assertion
 *  vacuously green.
 *
 *  NOT for tests that prove durability across a restart — close the store, reopen
 *  the same database, assert the rows survived. Those own their `mkdtemp` dir and
 *  their own engine, and a reset that runs on acquisition would erase the very
 *  thing they assert. Same for anything reading `dataDir`, and for a store backed
 *  by a real Postgres `url`.
 *
 *  NEVER with fake timers. `vi.useFakeTimers()` or `setSystemTime` in a file that
 *  shares a store is the one combination this helper cannot survive, and the
 *  reason is the invariant below.
 *
 *  THE SWEEPER INVARIANT. `composeSweep` (packages/vendo/src/compose-sweep.ts)
 *  arms a background TTL sweep on an interval and tears it down exactly one way:
 *  by wrapping `store.close`. A stack that borrows the shared store never closes
 *  it, so each umbrella-composing stack leaves its sweeper running for the rest
 *  of the FILE, and its `store.close` wrapper chained onto the shared handle.
 *  Both die with the file — the module graph, the engine and every closure over
 *  it are re-created per test file by vitest's isolated forks.
 *
 *  That is SAFE, and it is safe for reasons worth stating rather than assuming:
 *  the interval is unref'd (it never holds the event loop open), its cadence is
 *  60s against files that live a few seconds, and its TTL is 60 minutes, so on a
 *  real clock it has nothing to find and will not fire before the file is over.
 *  Every one of those reasons dies the moment a test moves the clock — fake
 *  timers would run an accumulated pile of sweepers, at once, against the shared
 *  database, denying another test's approvals. A file that needs fake timers
 *  needs its own engine. Only `fixtures/integration` and `umbrella-hookup`
 *  compose the umbrella at all; the other three suites hand-compose blocks and
 *  arm no sweeper.
 */
import { createStore, type VendoStore } from "@vendoai/vendo/store";

export interface SharedStoreOptions {
  /** Which engine to hand back. Unset is the file's one engine; a name is a
   *  second, independent one, for the tests that hold two at once. */
  engine?: string;
}

export async function emptySharedStore(options: SharedStoreOptions = {}): Promise<VendoStore> {
  const key = options.engine ?? "";
  let shared = sharedStores.get(key);
  if (shared === undefined) {
    const dataDir = `memory://vendo-fixture-shared-store-${sharedStores.size}`;
    const booting = (async () => {
      const store = createStore({ dataDir });
      await store.ensureSchema();
      return { store, raw: store.raw() as SharedStore["raw"] };
    })();
    // A failed boot must not poison the key: left in the map, the rejected
    // promise is handed to every later call in the file, so one flaky boot reads
    // as every remaining test failing on the FIRST test's error. Same
    // de-registration `store/db.ts:236-239` does for its shared-PGlite registry.
    booting.catch(() => {
      if (sharedStores.get(key) === booting) sharedStores.delete(key);
    });
    sharedStores.set(key, booting);
    shared = booting;
  }
  const { store, raw } = await shared;
  await raw.query(EMPTY);
  return store;
}

/** Everything a test can leave behind, worked out WHEN it is wiped rather than
 *  once at boot: `vendo_apps`'s per-app databases each live in a schema of their
 *  own (store/app-database.ts), created on demand, so the set is not knowable
 *  until the run that created them is over.
 *
 *  `vendo_meta` is left alone: it holds the schema version and boot id, which a
 *  freshly-ensured store also carries, and clearing it would re-run every
 *  migration. Same table `erase.ts` exempts, for the same reason. */
const EMPTY = `DO $$
DECLARE target text;
BEGIN
  SELECT string_agg(format('%I', tablename), ', ') INTO target
    FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'vendo_meta';
  IF target IS NOT NULL THEN EXECUTE 'TRUNCATE ' || target || ' RESTART IDENTITY CASCADE'; END IF;
  FOR target IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'vendo\\_app\\_%' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', target);
  END LOOP;
END $$`;

interface SharedStore {
  store: VendoStore;
  raw: { query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> };
}

const sharedStores = new Map<string, Promise<SharedStore>>();
