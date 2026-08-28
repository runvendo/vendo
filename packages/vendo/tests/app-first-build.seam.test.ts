/**
 * THE FIRST BUILD — a screen reads its own database on the build that CREATES
 * the app.
 *
 * This is the one ordering the rebuild could not survive, and it is the ordering
 * every real build has: the checks floor RUNS a screen's queries to validate it
 * (`checking/floor.ts` stage 4), and the app's row is written by the paint the
 * floor is gating (`delivered` → `authoredScreen`). So on the build that creates
 * an app, `vendo_apps_sql` is asked about an app that has no row yet — and so is
 * the `CREATE TABLE` the screen agent runs with its own hand a moment earlier.
 *
 * There is no stub on either side, because the two sides ARE the seam: the
 * producer is the write path that lands the row, the consumer is the floor that
 * runs the query before it. A harness that supplied its own `runQuery`, or that
 * seeded a row first, proves only that a read works once the app exists — which
 * is not what "first paint" means on the build that creates it, and is exactly
 * the shape that let this ship green.
 *
 * Everything here is the shipped piece: the real PGlite store, the real guard,
 * the real `createApps` runtime, the real agent-tool registry over the real
 * Postgres-schema app database, the real front door, and the real component
 * gauntlet. Only the choice of screen is scripted, because what is measured is
 * the doors.
 */
import { agentToolDescriptors, createApps, type AppsRuntime } from "@vendoai/apps";
import type { ScreenAssembler } from "@vendoai/apps/contract";
import type { AppId, Principal, RunContext, SqlDialect, ToolRegistry } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore, postgresAppDatabase, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const principal: Principal = { kind: "user", subject: "user_first_build" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "s_first_build" };
/** Somebody else, with no build of their own — the negative control below. */
const strangerCtx: RunContext = {
  principal: { kind: "user", subject: "user_stranger" },
  venue: "chat",
  presence: "present",
  sessionId: "s_stranger",
};

/** The tracker from the live repro, in one table and one screen: a shared table
 *  the build creates, and a first paint that reads it back. */
const TABLE = "CREATE TABLE shared.dog_birthdays (name TEXT PRIMARY KEY, day TEXT NOT NULL)";
const SEED = "INSERT INTO shared.dog_birthdays (name, day) VALUES (?, ?)";
const READ = "SELECT name, day FROM shared.dog_birthdays";

/** `useQuery` hands back the tool's OWN result (`vm-program.ts` `return
 *  data[key]`), so the rows are `birthdays.rows` — `.data` is only the shape of
 *  a read nobody has answered yet. Written the way the format reference teaches
 *  it, deliberately: the guidance and the runtime are the other seam this screen
 *  crosses, and a screen reading `.data.rows` paints an empty list forever. */
const SCREEN = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function DogBirthdays() {
  const birthdays = useQuery("vendo_apps_sql", { sql: "${READ}" });

  return (
    <Stack gap={12}>
      <Text text="Dog birthdays" variant="heading" />
      {(birthdays.rows ?? []).map((row) => (
        <Text key={row.name} text={row.name} />
      ))}
    </Stack>
  );
}
`;

async function pgStore(): Promise<VendoStore> {
  const store = createStore({
    dataDir: `memory://first-build-${process.pid}-${Math.random().toString(36).slice(2)}`,
  });
  cleanups.push(async () => store.close());
  await store.ensureSchema();
  return store;
}

/**
 * The apps pack's own tools, folded into the ONE registry the runtime is given.
 *
 * This is the fold `compose-surfaces.ts` performs for every real deployment
 * (`toolsFromRegistry(appsAgentTools, agentToolDescriptors(appSqlDialect))`),
 * and it is load-bearing here rather than decorative: it is what puts
 * `vendo_apps_sql` in the list the checks floor types a `useQuery` against, so a
 * screen can name it at all.
 */
const composedTools = (self: () => AppsRuntime, dialect: SqlDialect): ToolRegistry => ({
  async descriptors() { return agentToolDescriptors(dialect); },
  async execute(call, callCtx) { return self().agentTools().execute(call, callCtx); },
});

/** What a screen agent does on a build that needs storage, in the order the
 *  authoring guidance gives: make the table with its OWN call, then save the
 *  screen that reads it. Both land inside `assemble`, which is to say both land
 *  before the app has a row. */
const buildingAgent = (
  tools: () => ToolRegistry,
  floor: () => AppsRuntime,
  seen: { ran: string[]; painted: string[]; refusals: string[] },
): ScreenAssembler => ({
  async assemble(request, runCtx) {
    const sql = async (statement: string, params?: unknown[]): Promise<void> => {
      const outcome = await tools().execute({
        id: `call_${seen.ran.length}`,
        tool: "vendo_apps_sql",
        args: { appId: request.appId, sql: statement, ...(params === undefined ? {} : { params }) },
      }, runCtx);
      seen.ran.push(statement.split(" ").slice(0, 3).join(" "));
      if (outcome.status !== "ok") throw new Error(`${statement.slice(0, 28)}… → ${JSON.stringify(outcome)}`);
    };
    await sql(TABLE);
    await sql(SEED, ["Tato", "2021-06-04"]);
    const paint = await floor().floor(runCtx).component({ appId: request.appId, source: SCREEN });
    if (!paint.ok) {
      seen.refusals.push(...paint.blocking);
      return { kind: "unavailable", why: paint.blocking.join(" | ") };
    }
    // What the floor ACTUALLY rendered. The screen paints one <Text> per row the
    // query came back with, so the dog's name appearing here is the proof that
    // the floor ran the SELECT for real and got this app's own row — not that
    // some check merely declined to object.
    for (const node of Object.values(paint.nodes)) {
      const text = (node as { props?: { text?: unknown } }).props?.text;
      if (typeof text === "string") seen.painted.push(text);
    }
    return { kind: "assembled" };
  },
});

describe("a screen reads its own database on the build that CREATES the app", () => {
  it("makes its table, paints its own rows, and lands the row — no app seeded anywhere", async () => {
    const store = await pgStore();
    const guard = createGuard({ store, policy: "autopilot" });
    const database = postgresAppDatabase(store);
    expect(database).toBeDefined();
    const seen = { ran: [] as string[], painted: [] as string[], refusals: [] as string[] };
    let runtime: AppsRuntime;
    const tools = guard.bind(composedTools(() => runtime, database!.dialect));
    runtime = createApps({
      store,
      guard,
      appDatabase: database!,
      tools,
      catalog: [],
      screen: buildingAgent(() => tools, () => runtime, seen),
    });

    // The REAL front door, on an app that does not exist: `vendo_make` mints the
    // id and runs the build, so nothing here ever seeds a row.
    const outcome = await runtime.agentTools().execute({
      id: "call_make_tracker",
      tool: "vendo_make",
      args: { request: "a tracker for my dogs' birthdays" },
    }, ctx);

    expect(seen.refusals.join("\n")).toBe("");
    expect(outcome.status).toBe("ok");
    const receipt = (outcome as { output: { id: string; status: string } }).output;
    expect(receipt.status).toBe("ready");

    // Both halves of the ordering, in the order they happened: the agent's own
    // hand, then the floor's execution of the screen's first-paint query.
    expect(seen.ran).toEqual(["CREATE TABLE shared.dog_birthdays", "INSERT INTO shared.dog_birthdays"]);
    // Sorted, because the order of a FLAT tree's keys is the flattener's business
    // and not this test's. "Tato" is the whole assertion: it is on the screen only
    // if the floor really ran the SELECT and this app's own row came back.
    expect([...seen.painted].sort()).toEqual(["Dog birthdays", "Tato"]);

    // The row exists only because the paint landed it — which is the whole
    // point: everything above ran before this was true.
    const app = await runtime.get(receipt.id as AppId, ctx);
    expect(app?.id).toBe(receipt.id);

    // …and the app keeps its data after the build, read back through the same
    // door now that there IS a row to own.
    const read = await runtime.agentTools().execute({
      id: "call_read_back",
      tool: "vendo_apps_sql",
      args: { appId: receipt.id, sql: READ },
    }, ctx);
    expect(read.status).toBe("ok");
    expect((read as { output: { rows: unknown[] } }).output.rows)
      .toEqual([{ name: "Tato", day: "2021-06-04" }]);

    // THE NEGATIVE CONTROL. The mid-build exemption is one person's, for the
    // build they are running — it is not "an app with no row is anybody's". A
    // stranger naming an id that no build of theirs is minting is refused
    // exactly as before, and the app that HAS a row is masked from them.
    for (const [label, appId] of [["built", receipt.id], ["never built", "app_no_such_thing"]] as const) {
      const denied = await runtime.agentTools().execute({
        id: `call_stranger_${label.replace(" ", "_")}`,
        tool: "vendo_apps_sql",
        args: { appId, sql: READ },
      }, strangerCtx);
      expect(denied, label).toEqual({
        status: "error",
        error: { code: "not-found", message: `app not found: ${appId}` },
      });
    }
  });
});
