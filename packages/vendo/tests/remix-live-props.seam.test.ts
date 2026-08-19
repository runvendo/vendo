/**
 * THE HOST CALL-SITE'S LIVE PROPS BECOME THE GENERATED TOOL'S ARGUMENTS.
 *
 * `<Remixable><RewardsPanel accountId="acct_7" /></Remixable>` is the only place
 * `acct_7` exists: it is a prop of the host's own component instance, on the
 * host's own page, at render time. The port the ✦ fork starts from calls
 * `useQuery("rewards_panel_data")` with NO literal input — a screen's queries are
 * read out of the file and executed before it ever renders, so no prop can reach
 * one through the source. Without a wire that carries the value and a runner that
 * merges it, the generated tool is called with `{}` and the remix reads somebody
 * else's account, or nobody's.
 *
 * NOTHING IS STUBBED ON EITHER SIDE, which is the whole point:
 *
 *   WRITE  real HTTP `POST /api/vendo/apps/seed` with the live props on the body
 *          → the real seed surface → a real PGlite store, where the props land on
 *            `AppSeed.props`.
 *   READ   real HTTP `GET /api/vendo/apps/<id>/open` → the real checks floor →
 *          the real `screenQueryRunner` → the real guard-bound tool registry →
 *          the host's own `createVendo({ remixWiring })` tool, whose `execute`
 *          answers FROM its input.
 *
 * The producer cannot fake the consumer's answer and the consumer cannot fake the
 * producer's value: the assertion is text in the PAINTED TREE that only the tool
 * could have written, and only if it really received `accountId`.
 *
 * THE WIRING IS HAND-WRITTEN, deliberately. `.vendo/generated/remix-wiring.ts` is
 * a host-authored-shaped artifact — the host imports it and passes it to
 * `createVendo` — so writing one here uses the real consumer contract. The
 * splitter emitting a read tool that DECLARES its arguments is a separate defect
 * (`sync/split/port.ts:236-237` drops the call site's args and
 * `sync/split/wiring.ts:82` declares `properties: {}`); this test must not, and
 * does not, depend on it.
 *
 * THE ALLOWLIST is the tool's own `inputSchema.properties`. `secretToken` is sent
 * over the wire beside `accountId` and the tool never sees it — a generated tool
 * is exactly as wide as the call site the sync wrote it from, and the boundary is
 * a declared name list, never a filter over the value.
 *
 * THERE ARE TWO READ ARMS and both are tested, because the screen keeps reading
 * after it is painted: `screenQueryRunner` resolves the queries the server runs
 * (open, the checks floor, validate), and `POST /apps/:id/call` answers the
 * refetch the client fires after any mutation, replaying the compiled screen's
 * literal query plan. An arm that skips the merge does not error — it silently
 * reads another account.
 *
 * The ones that must be able to fail: drop the props merge from
 * `screenQueryRunner` (packages/apps/src/server/doors/build-surface.ts) or from
 * the read arm of `call` (packages/apps/src/server/doors/apps-surface.ts) and the
 * panel reads "rewards for undefined".
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeedBaseline } from "@vendoai/apps";
import type { AppDocument, Json, Principal } from "@vendoai/core";
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

/**
 * The splitter's port, in the shape it really emits: the read is one envelope
 * tool, and the `useQuery` call carries NO input — which is exactly why the
 * account id has to arrive some other way. `className`-free, because a ported
 * host class is refused by the runtime floor today (a separate live defect).
 */
const PORTED = `import { Stack, Text, useQuery } from "@vendo/screen";

export default function RewardsPanel() {
  const rewards = useQuery("rewards_panel_data");
  return (
    <Stack gap={12}>
      <Text text="Rewards" variant="heading" />
      <Text text={rewards?.label ?? "—"} />
      <Text text={rewards?.saw ?? "—"} />
    </Stack>
  );
}
`;

const baseline: SeedBaseline = {
  slot: "RewardsPanel",
  source: "export default function RewardsPanel() { return <p>rewards</p>; }\n",
  hash: "sha256:rewards-panel-1",
  exportable: false,
  capturedAt: "2026-08-18T09:00:00.000Z",
  ported: { source: PORTED, tools: ["rewards_panel_data"], holes: [] },
};

/**
 * The host's generated wiring, hand-written to the shape sync emits — except
 * that its read tool DECLARES the argument the original call site passed, and
 * answers from it. Both fields are proof-carrying: `label` can only name the
 * account the wire really delivered, and `saw` is the argument names the tool was
 * really handed, so a dropped prop and a leaked one are both visible in the paint.
 */
const remixWiring = {
  RewardsPanel: {
    tools: {
      rewards_panel_redeem: {
        name: "rewards_panel_redeem",
        description: "Redeem the points the RewardsPanel remixable component shows.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "write" as const,
        execute: async () => ({ redeemed: true }),
      },
      rewards_panel_data: {
        name: "rewards_panel_data",
        description: "Read the data the RewardsPanel remixable component renders.",
        inputSchema: {
          type: "object",
          properties: { accountId: { type: "string" } },
          additionalProperties: false,
        },
        risk: "read" as const,
        execute: async (input: Json) => {
          const args = input as Record<string, Json>;
          return {
            label: `rewards for ${String(args["accountId"])}`,
            saw: Object.keys(args).sort().join(","),
          };
        },
      },
    },
    holes: {},
  },
};

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

/** The screen agent's own brief — how a prompt is known to be the assembly
 *  loop's rather than the mandatory reviewer's. */
const SCREEN_BRIEF_MARKER = "# In this loop";

/** A model that plays the assembly loop's steps in order; everything that is not
 *  the loop gets prose, which the reviewer reads as "no findings". */
function scripted(steps: Array<() => Array<Record<string, unknown>>>): LanguageModel {
  const remaining = [...steps];
  const speak = (text: string): Array<Record<string, unknown>> => [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
  ];
  const model = {
    specificationVersion: "v2",
    provider: "vendo-live-props",
    modelId: "vendo-live-props-v1",
    supportedUrls: {},
    async doStream(request: { prompt?: unknown }) {
      const prompt = JSON.stringify(request.prompt ?? "");
      const step = prompt.includes(SCREEN_BRIEF_MARKER) ? remaining.shift() : undefined;
      const chunks = step === undefined ? speak("nothing to report") : step();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      };
    },
  };
  return model as unknown as LanguageModel;
}

const call = (toolName: string, input: unknown): Array<Record<string, unknown>> => [
  { type: "tool-call", toolCallId: "e1", toolName, input: JSON.stringify(input) },
  { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
];

const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A deployment whose `.vendo/remixable/` holds the baseline and whose
 *  `createVendo` holds the generated wiring — the two halves a real host has. */
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
    models: {
      default: scripted([
        // One real edit, so the ✦ operation completes the way it does in life:
        // seed the port, then run the person's instruction through the ordinary
        // edit door. The heading is the only thing it touches — the query stays
        // exactly as the port wrote it.
        () => call("edit_app", { find: 'text="Rewards"', replace: 'text="My rewards"' }),
      ]),
    },
    principal: async () => principal,
    store,
    remixWiring,
  });
}

describe("the host call-site's live props reach the generated tool's arguments", () => {
  it("carries them over the ✦ wire, stores them on the seed, and hands them to the tool on every server-side read", async () => {
    const vendo = await deployment();

    // ── THE WRITE PATH: real HTTP, with the live props of the instance the
    //    person pressed ✦ on. `secretToken` rides along as any extra prop would;
    //    the tool does not declare it.
    const seeded = await vendo.handler(request("POST", "/apps/seed", {
      component: "RewardsPanel",
      instruction: "call it my rewards",
      props: { accountId: "acct_7", secretToken: "must-not-cross" },
    }));
    expect(seeded.status).toBe(200);
    const app = await seeded.json() as AppDocument;
    // A refused port or a failed first edit leaves this marker instead of a
    // screen, and its reason is the only thing that says which.
    expect(app.buildFailed?.reason).toBeUndefined();

    // The props are provenance now — on the seed, beside the component and the
    // baseline, so every later read of this app resolves against the same call
    // site rather than against whatever the browser last happened to send.
    expect(app.seed?.props).toEqual({ accountId: "acct_7", secretToken: "must-not-cross" });

    // ── THE READ PATH: real HTTP open, which re-runs the screen through the real
    //    floor and resolves its queries through the real guard-bound registry.
    const opened = await vendo.handler(request("GET", `/apps/${app.id}/open`));
    expect(opened.status).toBe(200);
    const painted = JSON.stringify(await opened.json());

    // ── THE LOAD-BEARING ASSERTION. This string exists nowhere in the port, the
    //    baseline, the instruction or the wiring: the tool composed it from the
    //    argument it was handed. It can only be here if the browser's live prop
    //    crossed the wire, landed on the seed, and was merged into the call.
    expect(painted).toContain("rewards for acct_7");
    expect(painted).not.toContain("rewards for undefined");

    // ── THE BOUNDARY. The tool declares `accountId` and nothing else, so
    //    `accountId` is ALL it was handed. A generated tool is exactly as wide as
    //    the call site the sync wrote it from.
    expect(painted).toContain('"text":"accountId"');
    expect(painted).not.toContain("must-not-cross");

    // …and the edit really landed on the port, so this is the person's remix
    // being read and not the pristine capture.
    expect(painted).toContain("My rewards");
  }, 120_000);

  it("hands them to the tool on the REFETCH a mutation triggers, not only on the first paint", async () => {
    const vendo = await deployment();

    const seeded = await vendo.handler(request("POST", "/apps/seed", {
      component: "RewardsPanel",
      instruction: "call it my rewards",
      props: { accountId: "acct_7", secretToken: "must-not-cross" },
    }));
    expect(seeded.status).toBe(200);
    const app = await seeded.json() as AppDocument;
    expect(app.buildFailed?.reason).toBeUndefined();

    // The first paint, which already worked: the screen opens reading acct_7.
    const opened = await vendo.handler(request("GET", `/apps/${app.id}/open`));
    expect(opened.status).toBe(200);
    expect(JSON.stringify(await opened.json())).toContain("rewards for acct_7");

    // ── THE MUTATION. Anything the person presses that writes; the screen's
    //    client refreshes itself afterwards.
    const mutated = await vendo.handler(request("POST", `/apps/${app.id}/call`, {
      ref: "rewards_panel_redeem",
      args: {},
    }));
    expect(mutated.status).toBe(200);
    expect(await mutated.json()).toMatchObject({ status: "ok" });

    // ── THE REFETCH, byte for byte what `reread` sends: the compiled screen's
    //    literal query plan, whose input the port wrote as nothing. The live
    //    props are in no source it can read, so this call is the whole test.
    const refetched = await vendo.handler(request("POST", `/apps/${app.id}/call`, {
      ref: "rewards_panel_data",
      args: {},
    }));
    expect(refetched.status).toBe(200);
    const outcome = await refetched.json() as { status: string; output: { label: string; saw: string } };
    expect(outcome.status).toBe("ok");
    // The load-bearing assertion: a refetch that dropped the prop reads
    // "rewards for undefined" and silently paints somebody else's account.
    expect(outcome.output.label).toBe("rewards for acct_7");
    // The boundary holds on this arm too — `secretToken` rode the same wire and
    // the tool declares only `accountId`, so `accountId` is all it was handed.
    expect(outcome.output.saw).toBe("accountId");

    // …and a read that DOES name the argument still wins over the seed: the plan
    // is the screen's own source, which is the source the checks read.
    const explicit = await vendo.handler(request("POST", `/apps/${app.id}/call`, {
      ref: "rewards_panel_data",
      args: { accountId: "acct_from_the_plan" },
    }));
    expect(await explicit.json()).toMatchObject({ output: { label: "rewards for acct_from_the_plan" } });
  }, 120_000);
});
