/**
 * A BROKEN ARTIFACT IS NOT A RETRIABLE REQUEST.
 *
 * `open()` refuses a stored app it can never serve with a `validation` VendoError
 * — a served row whose machine is gone, or a screen that no longer renders
 * (`persistence/open.ts`). The wire's build window only rescued `not-found`, so
 * those two reached the caller as a bare HTTP 400: no reason, and a status every
 * agent reads as "try again". One did, on the identical response, for 7.7 minutes
 * until its turn budget died.
 *
 * So this drives both refusals through the REAL seam and asserts the answer is
 * terminal and self-explaining. The producer is a shipped write door
 * (`authoredScreen` for a screen that went bad after it landed, `importApp` for a
 * served document whose machine never crosses interchange) over a real store; the
 * consumer is the real `GET /apps/:id/open` route on the real composed handler.
 * Nothing is stubbed on either side, and the screen really renders — and really
 * crashes — in the sealed VM.
 *
 * What must be able to fail: drop the `validation` arm from `openApp`
 * (`src/wire/apps.ts`) and both terminal reads go red with a 400 carrying no
 * `reason` an agent could act on. The healthy open below is the premise — it
 * proves this deployment paints screens at all, so a refusal here is the SCREEN's
 * and not a deployment with no engine wired.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDO_APP_FORMAT, type AppDocument, type AppId, type Principal, type RunContext } from "@vendoai/core";
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

async function setup(): Promise<Vendo> {
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
    // And the permanence, in the wire's existing vocabulary: no retry can change
    // a stored record.
    expect(body.retryable).toBe(false);
    // The embed's flagged poll gets the same terminal answer, never a `pending`
    // it would spin on to its deadline.
    expect(await answer(await open(vendo, "app_broken_screen", "?pending=1"))).toEqual({ status, body });
  }, 60_000);

  it("a served app whose machine is gone says its surface is gone, and names the fix", async () => {
    const vendo = await setup();
    // A machine ref never crosses interchange, so importing a served document is
    // the shipped way one lands with `ui: "http"` and nothing to serve.
    const imported = await vendo.apps.importApp({
      format: VENDO_APP_FORMAT,
      id: "app_served_import" as AppId,
      name: "Served app",
      ui: "http",
    } as AppDocument, ctx);

    const { status, body } = await answer(await open(vendo, imported.id));

    expect(status).toBe(200);
    expect(body.kind).toBe("failed");
    expect(body.reason).toContain("has no machine");
    expect(body.reason).toContain("re-create the app");
    expect(body.retryable).toBe(false);
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
