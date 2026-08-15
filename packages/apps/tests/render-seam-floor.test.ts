/**
 * The checks floor AT the paint seam — blueprint §7.1.
 *
 * THE HOLE THESE TESTS CLOSE. The seam used to read the hot-path file itself and
 * decide what to paint, so a harness's own writes faced a different gate than
 * every other author's:
 *
 *  - a LYING read (a field the tool's declared response does not have) painted
 *    happily, and the app promised a value it could never show.
 *  - a break nobody could see from the outside — a screen that would not render,
 *    or one the host's own plugged check refuses — reached the user, because
 *    nothing at the seam ever ran it.
 *
 * The seam never learns to read `app.tsx` now: `options.floor.component()` is the
 * whole gate, and it is the gauntlet every other door runs. So nothing here stubs
 * either half — the floor is the REAL floor (`createAppFloor`: real esbuild, real
 * tsc, the real sealed VM) and the write goes through the REAL workspace commit
 * path, because the repo's standing lesson is that a harness which mocks its
 * counterparty proves nothing: "the host-component previews shipped four times
 * with a green suite and a dead feature because the producer and the consumer each
 * mocked the other, so they could never disagree."
 */
import { createAppFloor } from "../src/server/checking/floor.js";
import type { VendoViewPart } from "@vendoai/core";
import type {
  AppFloor,
  Check,
  NormalizedCatalog,
} from "../src/contract/index.js";
import type { HostToolInfo } from "../src/server/checking/deps.js";
import type { LanguageModel } from "ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { warmScreenEngine } from "../src/contract/index.js";
import { wrapWorkspaceForRender } from "../src/server/generation/render-seam.js";
import { testWorkspace } from "./test-doubles.test-util.js";

const APP = "app_1";
const APP_TSX = `/user/apps/${APP}/app.tsx`;

const TOOL = "maple_spend_summary";

/** The host surface the floor measures against — one read tool whose response
 *  carries `total` and nothing else, which is what makes `grandTotal` a lie
 *  rather than a typo nobody can catch. */
const tools: readonly HostToolInfo[] = [{
  name: TOOL,
  description: "This month's spending",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  outputSchema: {
    type: "object",
    properties: { total: { type: "number" } },
    required: ["total"],
    additionalProperties: false,
  },
}];

const catalog: NormalizedCatalog = [];

/** What the tool really answers when the gauntlet executes the screen's query. */
const ANSWER = { total: 4210 };

/**
 * A model that THROWS if anything calls it.
 *
 * The seam runs on every commit, so the floor it calls there must be the
 * deterministic half only — the AI reviewer spends a model call and belongs to
 * `validate`. This is how that stays true instead of being asserted in a comment.
 */
const forbiddenModel = new Proxy({}, {
  get: () => {
    throw new Error("the paint seam must never spend a model call");
  },
}) as unknown as LanguageModel;

const floor = (checks: readonly Check[] = []): AppFloor => createAppFloor({
  deps: async () => ({ model: forbiddenModel, catalog, tools }),
  checks,
  runQuery: async () => ANSWER,
});

beforeAll(async () => {
  await warmScreenEngine();
});

/** The seam as the runtime builds it, with the real floor injected. */
function seam(options: { withFloor?: boolean; checks?: readonly Check[] } = {}) {
  const emitted: Array<{ id: string; part: VendoViewPart }> = [];
  const workspace = wrapWorkspaceForRender(testWorkspace(), {
    emit: (id, part) => emitted.push({ id, part }),
    ...(options.withFloor === false ? {} : { floor: floor(options.checks) }),
  });
  /** Write then commit — what the runtime does for every hand that writes. */
  const save = async (content: string): Promise<void> => {
    await workspace.writeFile(APP_TSX, content);
    await workspace.commit();
  };
  return { emitted, save, workspace };
}

const screen = (body: string, name = "Spending"): string => `import { Stack, Text, useQuery } from "@vendo/screen";

export default function ${name}() {
  const spend = useQuery("${TOOL}");
  return (
    <Stack>
      ${body}
    </Stack>
  );
}
`;

/** Honest: `total` is a field the tool really returns. */
const HONEST = screen(`<Text text={String(spend.total)} />`);
/** A LYING read: `grandTotal` is absent from the tool's response shape, so the
 *  label promises a number the app can never show. */
const LYING = screen(`<Text text={String(spend.grandTotal)} />`);

const painted = (emitted: Array<{ part: VendoViewPart }>): unknown =>
  emitted.at(-1)?.part.payload;

describe("a lying read never reaches the user (proof bar 1)", () => {
  it("paints the honest screen, refuses the lie, and paints again when it is restored", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { emitted, save } = seam();

    // 1. The honest screen paints, on the data its query really returned.
    await save(HONEST);
    expect(emitted).toHaveLength(1);
    const lastGood = painted(emitted);
    expect(JSON.stringify(lastGood)).toContain("4210");

    // 2. The lie lands in the store and emits NOTHING. The last good view stays
    //    on screen — the seam's own mechanism, not a new failure channel.
    await save(LYING);
    expect(emitted).toHaveLength(1);
    expect(painted(emitted)).toEqual(lastGood);
    // …and the refusal names the field, because a model repairs from it.
    expect(logged.mock.calls.map(String).join("\n")).toContain('reads field "grandTotal"');

    // 3. Restore the read and it paints.
    await save(HONEST);
    expect(emitted).toHaveLength(2);
    expect(JSON.stringify(painted(emitted))).toContain("4210");
    logged.mockRestore();
  }, 60_000);

  it("still LANDS the lying write — the floor refuses the paint, never the commit", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { save, workspace } = seam();
    await save(LYING);
    // The brokenness reaches the harness through `validate`, never the user, so
    // the bytes must be on disk for it to read back and repair.
    await expect(workspace.readFile(APP_TSX)).resolves.toBe(LYING);
    logged.mockRestore();
  }, 60_000);

  it("is invisible without the floor — nothing at the seam can see it", async () => {
    // The counter-proof: the SAME lie, the same real commit path, no floor. The
    // seam has no reader of its own, so it does not paint the lie — it paints
    // NOTHING, for the honest screen either. The gate and the paint are one thing.
    const { emitted, save } = seam({ withFloor: false });
    await save(LYING);
    await save(HONEST);
    expect(emitted).toEqual([]);
  }, 60_000);
});

/**
 * The host's OWN checks, landing at the seam — §7.1 item 2.
 *
 * The floor does not care who wrote the screen: a plugged check fires on a
 * harness's write exactly as it fires on a create. Each case asserts the same
 * three things: the honest screen is on screen first, the refused write emits
 * NOTHING so that view stays, and the operator's log names THE CHECK that
 * refused — which is what makes this a test of the floor rather than of the
 * compiler, since the screen below type-checks and renders perfectly cleanly.
 */
describe("a host check reaches the seam", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const houseStyle: Check = {
    name: "house-style",
    kind: "fact",
    run: async () => [{ severity: "block", where: "document", message: "Maple never shows a bare total" }],
  };

  it("blocks the paint, and the log says which check did it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { emitted, save } = seam({ checks: [houseStyle] });

    await save(HONEST);

    expect(emitted).toEqual([]);
    const text = logged.mock.calls.map(String).join("\n");
    expect(text).toContain("[house-style]");
    expect(text).toContain("Maple never shows a bare total");
  }, 60_000);

  it("paints without it — which is what makes the block the check's own doing", async () => {
    const { emitted, save } = seam();
    await save(HONEST);
    expect(emitted).toHaveLength(1);
  }, 60_000);

  it("a warn rides along on a screen that ships", async () => {
    const advisory: Check = {
      name: "house-style",
      kind: "fact",
      run: async () => [{ severity: "warn", where: "document", message: "this screen feels thin" }],
    };
    const { emitted, save } = seam({ checks: [advisory] });

    await save(HONEST);

    expect(emitted).toHaveLength(1);
  }, 60_000);
});
