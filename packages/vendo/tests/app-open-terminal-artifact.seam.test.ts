/**
 * A REFUSED OPEN SAYS WHY, AND CLAIMS NOTHING MORE THAN IT KNOWS.
 *
 * `open()` refuses a stored app it cannot serve with a `validation` VendoError —
 * a screen the floor would not pass. The wire's build window only rescued
 * `not-found`, so those reached the caller as a bare HTTP 400: no reason, and a
 * status every agent reads as "try again". One did, on the identical response,
 * for 7.7 minutes until its turn budget died.
 *
 * The answer now carries the refusal's own words in the terminal shape this wire
 * already speaks. What it must NOT carry is a verdict on retrying: that door's
 * refusals are a mixed class. "This screen did not render" covers a screen that
 * will never compile AND a query the guard blocked, an unconnected toolkit, a
 * read awaiting approval, or a deployment missing esbuild/tsc/QuickJS
 * (`server/checking/component-screen.ts`) — and the wire cannot tell which it
 * got. The last test here is that case, end to end: the same stored app that
 * refused opens fine once its dependency answers.
 *
 * The producer is a shipped write door (`authoredScreen` for a screen that went
 * bad after it landed) over a real store; the consumer is the real
 * `GET /apps/:id/open` on the real composed handler. Nothing is stubbed on either
 * side, and the screen really renders — and really crashes — in the sealed VM.
 *
 * What must be able to fail: drop the `validation` arm from `openApp`
 * (`src/wire/apps.ts`) and every read here goes red with a 400 carrying no
 * `reason` an agent could act on; add `retryable: false` back to it and the
 * recoverable case goes red. The healthy open is the premise — it proves this
 * deployment paints screens at all, so a refusal here is the SCREEN's and not a
 * deployment with no engine wired.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppId,
  type Json,
  type Principal,
  type RunContext,
  type ToolDefinition,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";
import { FIXTURE_SCREEN } from "./screen-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ADA: Principal = { kind: "user", subject: "user_ada" };
const ctx: RunContext = { principal: ADA, venue: "app", presence: "present", sessionId: "session_ada" };

/** Renders once, reaches through a value nothing is behind, and takes the screen
 *  down with it — the shape a host tool that moved under a stored app leaves.
 *  It passes admission and type-checks, so only the render stage can see it. */
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

/** A sound screen whose one query has to answer for it to paint — the paint runs
 *  the query for real on every open, so this screen's fate follows its world. */
const QUERYING_SCREEN = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function Balance() {
  const balance = useQuery("host_balance");
  return (
    <Stack>
      <Text text={String(balance.data.cents)} />
    </Stack>
  );
}
`;

async function setup(tools: ToolDefinition[] = []): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-open-terminal-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  return createVendo({
    models: { default: {} as LanguageModel },
    principal: async (request) => {
      const subject = request.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
    tools,
  });
}

const open = (vendo: Vendo, appId: string, query = ""): Promise<Response> => vendo.handler(
  new Request(`http://wire.test/api/vendo/apps/${appId}/open${query}`, { headers: { "x-test-user": ADA.subject } }),
);

interface Answer {
  status: number;
  body: { kind?: string; reason?: string; retryable?: boolean; error?: { code: string; message: string } };
}

const answer = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: await response.json() as Answer["body"],
});

describe("opening an app that can never be served answers terminally, not 400", () => {
  it("a screen that no longer renders comes back as failed, with the render's own words", async () => {
    const vendo = await setup();
    // The door that stores screens, because a refused paint leaves no row: an app
    // whose screen went bad AFTER it landed is exactly this state.
    await vendo.apps.authoredScreen(
      { appId: "app_broken_screen" as AppId, name: "Broken", source: CRASHING_SCREEN },
      ctx,
    );

    const { status, body } = await answer(await open(vendo, "app_broken_screen"));

    expect(status).toBe(200);
    expect(body.kind).toBe("failed");
    // The reason the refusal carried, carried through: what is wrong with the
    // artifact, in the words that name where to fix it.
    expect(body.reason).toContain("this screen did not render");
    expect(body.reason).toMatch(/threw while rendering/);
    // No verdict on retrying: this screen's own fault is permanent, but the wire
    // cannot see that from the refusal, so it says nothing it cannot know.
    expect(body.retryable).toBeUndefined();
    // The embed's flagged poll gets the same terminal answer, never a `pending`
    // it would spin on to its deadline.
    expect(await answer(await open(vendo, "app_broken_screen", "?pending=1"))).toEqual({ status, body });
  }, 60_000);

  it("does not call a recoverable refusal permanent — the same app opens once its query answers", async () => {
    // The reviewer's case (PR #1537), and the one the enumeration confirmed:
    // `open.ts:221` also fires when a screen's QUERY would not answer — a guard
    // that blocked it, an unconnected toolkit, a read awaiting approval, a tool
    // that was simply down (`build-surface.ts:379-385` → `component-screen.ts:663`).
    // The screen is fine; its world was not.
    let down = true;
    const vendo = await setup([{
      name: "host_balance",
      title: "Balance",
      description: "The account balance.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
      execute: async () => {
        if (down) throw new Error("the balance service is warming up");
        return { data: { cents: 4200 } } as unknown as Json;
      },
    }]);
    await vendo.apps.authoredScreen(
      { appId: "app_flaky_query" as AppId, name: "Balance", source: QUERYING_SCREEN },
      ctx,
    );

    const refused = await answer(await open(vendo, "app_flaky_query"));
    expect(refused.status).toBe(200);
    expect(refused.body.kind).toBe("failed");
    // The reason still reaches the caller — that is the whole fix.
    expect(refused.body.reason).toContain("the balance service is warming up");
    // But nothing claims a retry is pointless, because here it is not.
    expect(refused.body.reason).not.toMatch(/retry|permanent/i);
    expect(refused.body.retryable).toBeUndefined();

    // The proof that the refusal was recoverable: nothing about the stored app
    // changed, the world did.
    down = false;
    const served = await answer(await open(vendo, "app_flaky_query"));
    expect(served.status).toBe(200);
    expect(served.body.kind).toBe("tree");
  }, 60_000);

  it("still paints a sound screen, and still masks an app that is not there", async () => {
    const vendo = await setup();
    await vendo.apps.authoredScreen(
      { appId: "app_sound" as AppId, name: "Sound", source: FIXTURE_SCREEN },
      ctx,
    );

    // The premise: this deployment really does paint screens, so the refusal
    // above belongs to the broken screen and not to a missing engine.
    const painted = await answer(await open(vendo, "app_sound"));
    expect(painted.status).toBe(200);
    expect(painted.body.kind).toBe("tree");

    // And the transient answers are untouched: an app nobody can see keeps its
    // contracted 404 unflagged, and the build window keeps its quiet `pending`.
    const missing = await answer(await open(vendo, "app_ghost"));
    expect(missing.status).toBe(404);
    expect(missing.body.error?.code).toBe("not-found");
    expect(await answer(await open(vendo, "app_ghost", "?pending=1")))
      .toEqual({ status: 200, body: { kind: "pending" } });
  }, 60_000);
});
