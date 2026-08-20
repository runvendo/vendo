/**
 * THE HOST CALL-SITE'S LIVE PROPS BECOME THE PORTED SCREEN'S MOUNT PROPS.
 *
 * `<Remixable><NetWorthView valueCents={14292930} /></Remixable>` is the only
 * place `14292930` exists: it is a prop of the host's own component instance, on
 * the host's own page, at render time. The port the ✦ fork starts from renders
 * FROM ITS PROPS — no query, no literal in the source — so the only values it can
 * paint are the ones the server hands its VM.
 *
 * Without a courier, the server hands it `vendo sync`'s CAPTURED `sampleProps`:
 * the values frozen the day the baseline was written
 * (`doors/build-surface.ts` — the props resolver the checks floor consults). The
 * remix then paints yesterday's number forever while the host's own component,
 * two inches away, paints today's. That is the live defect this seam closes: the
 * observed remix read $54,907.15 — `valueCents: 5490715`, exactly the capture in
 * `examples/demo-bank/.vendo/remixable/NetWorthView.json` — while the page read
 * $142,929.30.
 *
 * NOTHING IS STUBBED ON EITHER SIDE, which is the whole point:
 *
 *   WRITE  real HTTP `POST /api/vendo/apps/<id>/props` with the live props of the
 *          instance on the page → the real seed surface → a real PGlite store,
 *          where they land on `AppSeed.props`.
 *   READ   real HTTP `GET /api/vendo/apps/<id>/open` → the real checks floor →
 *          the real component gauntlet, which PAINTS the port on those props.
 *
 * The producer cannot fake the consumer's answer and the consumer cannot fake the
 * producer's value: the assertion is text in the PAINTED TREE that only the
 * screen could have written, and only if it really received the live number.
 *
 * ON CHANGE IS THE POINT, not just on fork. The first open is asserted STALE on
 * purpose — that is the bug, reproduced through the real wire — and the same app
 * is then couriered and re-opened. An implementation that only seeded props at
 * fork time passes the first half and fails the second.
 *
 * THE ALLOWLIST is the captured baseline's own declared props. `secretToken`
 * rides the same wire beside `valueCents` and the screen never sees it — even
 * though this port DECLARES `secretToken` in its own props type, so the filter is
 * proved to be the boundary rather than the screen merely being unable to name
 * it. The paint carries `saw`, the prop names the VM really received, so a
 * dropped prop and a leaked one are both visible in the tree.
 *
 * The one that must be able to fail: drop the `seed.props` preference from the
 * props resolver in `packages/apps/src/server/doors/build-surface.ts` and the
 * screen paints the captured 5490715 forever.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeedBaseline } from "@vendoai/apps";
import type { AppDocument, Principal } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_live_props" };

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  process.chdir(originalCwd);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The captured value — what `vendo sync` froze, and what a remix with no
 *  courier paints forever. The real one, off the demo's own baseline. */
const CAPTURED_CENTS = 5490715;
/** What the host's page is really rendering when the person presses ✦. */
const LIVE_CENTS = 14292930;
/** …and after a transfer moves the balance. The on-change half. */
const MOVED_CENTS = 9910430;

/**
 * The splitter's port, in the shape it really emits for a presentational
 * component: it renders FROM PROPS and asks no query, which is exactly why the
 * live number has to arrive as a mount prop or not at all.
 *
 * `secretToken` is declared here deliberately. The boundary must be the courier's
 * allowlist, not the screen's vocabulary — a port that could not name the decoy
 * would prove nothing about whether the decoy crossed.
 */
const PORTED = `import { Stack, Text } from "@vendo/screen";

export default function NetWorthView(props: { valueCents?: number; secretToken?: string }) {
  const saw = Object.keys(props).sort().join(",");
  return (
    <Stack gap={12}>
      <Text text="Net worth" variant="heading" />
      <Text text={"value " + String(props.valueCents)} />
      <Text text={"saw " + saw} />
    </Stack>
  );
}
`;

const baseline: SeedBaseline = {
  slot: "NetWorthView",
  source: "export default function NetWorthView() { return <p>net worth</p>; }\n",
  hash: "sha256:net-worth-view-1",
  exportable: false,
  capturedAt: "2026-08-18T09:00:00.000Z",
  // The frozen capture: the stale number, and the declared-prop list the
  // courier's allowlist is drawn from.
  sampleProps: { valueCents: CAPTURED_CENTS },
  ported: { source: PORTED, tools: [], holes: [] },
};

/**
 * The person's remix — the screen the wish lands, and the thing actually read in
 * every assertion below. It renders FROM PROPS and asks no query, exactly like
 * the port it grew from, so the only values it can paint are the ones the server
 * hands its VM.
 *
 * `secretToken` is declared here deliberately. The boundary must be the courier's
 * allowlist, not the screen's vocabulary — a screen that could not name the decoy
 * would prove nothing about whether the decoy crossed.
 */
const REMIX = `import { Stack, Text } from "@vendo/screen";

export default function NetWorthView(props: { valueCents?: number; secretToken?: string }) {
  const saw = Object.keys(props).sort().join(",");
  return (
    <Stack gap={12}>
      <Text text="Tracked monthly" variant="heading" />
      <Text text={"value " + String(props.valueCents)} />
      <Text text={"saw " + saw} />
    </Stack>
  );
}
`;

/** The screen agent's own brief — how a prompt is known to be the assembly
 *  loop's rather than the mandatory reviewer's. */
const SCREEN_BRIEF_MARKER = "# In this loop";

/**
 * A model that assembles the remix once, so the ✦ operation completes the way it
 * does in life: seed the port, then land the person's wish through the ordinary
 * edit door. Every other prompt gets prose, which is also what ends the loop once
 * the app is saved, and what the mandatory reviewer reads as "no findings".
 *
 * Same shape as this package's other fixture doubles (`mcp-door.test-util.ts`
 * `screenModel`) — the streamed `finishReason` is a plain string there, and a
 * double that answers any other shape never lands a screen at all.
 */
const scripted = (): LanguageModel => {
  let saved = false;
  const assembling = (prompt: unknown): boolean => {
    if (saved || !JSON.stringify(prompt ?? "").includes(SCREEN_BRIEF_MARKER)) return false;
    saved = true;
    return true;
  };
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
  const saveCall = {
    type: "tool-call" as const,
    toolCallId: "call_save_app",
    toolName: "save_app",
    input: JSON.stringify({ content: REMIX }),
  };
  return {
    specificationVersion: "v2",
    provider: "vendo-live-props",
    modelId: "vendo-live-props-v1",
    supportedUrls: {},
    async doGenerate({ prompt }: { prompt?: unknown }) {
      return assembling(prompt)
        ? { content: [saveCall], finishReason: "tool-calls" as const, usage }
        : { content: [{ type: "text" as const, text: "done" }], finishReason: "stop" as const, usage };
    },
    async doStream({ prompt }: { prompt?: unknown }) {
      const save = assembling(prompt);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (save) {
              controller.enqueue(saveCall);
              controller.enqueue({ type: "finish", finishReason: "tool-calls", usage });
            } else {
              controller.enqueue({ type: "text-start", id: "text_1" });
              controller.enqueue({ type: "text-delta", id: "text_1", delta: "done" });
              controller.enqueue({ type: "text-end", id: "text_1" });
              controller.enqueue({ type: "finish", finishReason: "stop", usage });
            }
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
};

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A deployment whose `.vendo/remixable/` holds the captured baseline — the half
 *  a real host has on disk. */
async function deployment() {
  const root = await mkdtemp(join(tmpdir(), "vendo-live-props-"));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".vendo", "remixable"), { recursive: true });
  await writeFile(
    join(root, ".vendo", "remixable", `${baseline.slot}.json`),
    JSON.stringify(baseline, null, 2),
  );
  const store = createStore({ dataDir: join(root, ".data") });
  await store.ensureSchema();
  cleanups.push(async () => store.close());
  process.chdir(root);
  return createVendo({
    models: { default: scripted() },
    principal: async () => principal,
    store,
  });
}

/** Mint the remix the way the ✦ does, and fail loudly if the port refused. */
async function seeded(vendo: { handler(request: Request): Promise<Response> }) {
  const response = await vendo.handler(request("POST", "/apps/seed", {
    component: "NetWorthView",
    instruction: "call it tracked monthly",
  }));
  expect(response.status).toBe(200);
  const app = await response.json() as AppDocument;
  // A refused port or a failed first edit leaves this marker instead of a
  // screen, and its reason is the only thing that says which.
  expect(app.buildFailed?.reason).toBeUndefined();
  return app;
}

const paintOf = async (vendo: { handler(request: Request): Promise<Response> }, appId: string) => {
  const opened = await vendo.handler(request("GET", `/apps/${appId}/open`));
  expect(opened.status).toBe(200);
  return JSON.stringify(await opened.json());
};

describe("the host call-site's live props reach the ported screen's paint", () => {
  it("paints the CAPTURED props until a courier lands, then paints the live ones", async () => {
    const vendo = await deployment();
    const app = await seeded(vendo);

    // ── THE DEFECT, reproduced through the real wire. With nothing couriered the
    //    floor resolves the frozen capture, so the remix opens on the number the
    //    baseline was written with — the $54,907.15 the browser really showed.
    expect(await paintOf(vendo, app.id)).toContain(`value ${CAPTURED_CENTS}`);

    // ── THE WRITE PATH: real HTTP, with the live props of the instance the
    //    person is looking at. `secretToken` rides along as any extra prop would;
    //    the captured baseline does not declare it.
    const couriered = await vendo.handler(request("POST", `/apps/${app.id}/props`, {
      props: { valueCents: LIVE_CENTS, secretToken: "must-not-cross" },
    }));
    expect(couriered.status).toBe(200);

    // The props are provenance now — on the seed, beside the component and the
    // baseline, so every later read of this app resolves against the call site
    // rather than against whatever the capture froze. The decoy is filtered at
    // the DOOR, so it is never stored either.
    const stored = await couriered.json() as AppDocument;
    expect(stored.seed?.props).toEqual({ valueCents: LIVE_CENTS });

    // ── THE READ PATH: real HTTP open, which re-runs the screen through the real
    //    floor and paints it on the props the courier landed.
    const painted = await paintOf(vendo, app.id);

    // ── THE LOAD-BEARING ASSERTION. This number exists nowhere in the port, the
    //    baseline, the instruction or the capture: the screen painted it from the
    //    prop it was handed. It can only be here if the browser's live prop
    //    crossed the wire, landed on the seed, and reached the VM.
    expect(painted).toContain(`value ${LIVE_CENTS}`);
    expect(painted).not.toContain(`value ${CAPTURED_CENTS}`);

    // ── THE BOUNDARY. The baseline declares `valueCents` and nothing else, so
    //    `valueCents` is ALL the screen was handed — even though this port's own
    //    props type names `secretToken`.
    expect(painted).toContain('"text":"saw valueCents"');
    expect(painted).not.toContain("must-not-cross");

    // …and the edit really landed on the port, so this is the person's remix
    // being read and not the pristine capture.
    expect(painted).toContain("Tracked monthly");
  }, 120_000);

  it("follows the host page ON CHANGE, not only on the first courier", async () => {
    const vendo = await deployment();
    const app = await seeded(vendo);

    const courier = async (valueCents: number) => {
      const response = await vendo.handler(request("POST", `/apps/${app.id}/props`, {
        props: { valueCents, secretToken: "must-not-cross" },
      }));
      expect(response.status).toBe(200);
    };

    // The page as the person first sees it.
    await courier(LIVE_CENTS);
    expect(await paintOf(vendo, app.id)).toContain(`value ${LIVE_CENTS}`);

    // ── THE CHANGE. A transfer moves the balance, the host re-renders the
    //    wrapped component with a new prop, and the wrapper couriers it. This is
    //    the half a fork-time-only implementation cannot pass.
    await courier(MOVED_CENTS);
    const moved = await paintOf(vendo, app.id);
    expect(moved).toContain(`value ${MOVED_CENTS}`);
    expect(moved).not.toContain(`value ${LIVE_CENTS}`);

    // The boundary holds on every courier, not just the first.
    expect(moved).toContain('"text":"saw valueCents"');
    expect(moved).not.toContain("must-not-cross");
  }, 120_000);
});
