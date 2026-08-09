/**
 * The view channel's description contract — §3.3.
 *
 * The seam used to emit `UIPayload` — `{ formatVersion: string; [k: string]:
 * unknown }` — so nothing anywhere held the channel to a shape and every consumer
 * read its seven real fields by inline cast. Now the seam GATES: what it compiles
 * must parse as a `ScreenDescription` or nothing paints, which is the law this
 * file already lived by for content that does not compile.
 *
 * Written through the real seam (`writeFile` + `commit()`, the store-write moment)
 * and read back off the real emitted part. Nothing is stubbed on either side.
 */
import { screenDescriptionSchema, VENDO_SCREEN_FORMAT, type VendoViewPart } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { wrapWorkspaceForRender } from "../src/render-seam.js";
import { testWorkspace } from "../src/test-doubles.test-util.js";

const APP = "app_screen";
const APP_VENDO = `/user/apps/${APP}/app.vendo`;
const PLAN_VENDO = `/user/apps/${APP}/plan.vendo`;
const TURN = "trn_0123456789abcdef0123456789abcdef";

const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="Hello" />
  </Stack>
</App>`;

const GOOD_PLAN = `<Plan name="Spending">
  <Group title="This month">
    <Leaf component="DataTable" />
  </Group>
</Plan>`;

function seam(options: { turnId?: string } = {}) {
  const emitted: Array<VendoViewPart> = [];
  const workspace = wrapWorkspaceForRender(testWorkspace(), {
    emit: (_id, part) => emitted.push(part),
    ...(options.turnId === undefined ? {} : { turnId: options.turnId }),
  });
  const save = async (path: string, content: string): Promise<void> => {
    await workspace.writeFile(path, content);
    await workspace.commit();
  };
  return { emitted, save };
}

describe("the emitted description (§3.3)", () => {
  it("parses against the contract — an app's compiled screen", async () => {
    const { emitted, save } = seam();
    await save(APP_VENDO, GOOD_APP);
    expect(emitted).toHaveLength(1);
    const parsed = screenDescriptionSchema.safeParse(emitted[0]!.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(emitted[0]!.payload.formatVersion).toBe(VENDO_SCREEN_FORMAT);
  });

  it("parses against the contract — a plan's skeleton", async () => {
    const { emitted, save } = seam();
    await save(PLAN_VENDO, GOOD_PLAN);
    expect(emitted).toHaveLength(1);
    const parsed = screenDescriptionSchema.safeParse(emitted[0]!.payload);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // A plan IS the mid-build state, and the flag is server-authoritative.
    expect(emitted[0]!.payload["streaming"]).toBe(true);
  });

  it("stamps the turn that painted it", async () => {
    const { emitted, save } = seam({ turnId: TURN });
    await save(APP_VENDO, GOOD_APP);
    expect(emitted[0]!.turnId).toBe(TURN);
  });

  it("emits nothing at all when the compiled screen is not a description", async () => {
    const { emitted, save } = seam();
    // `<App>` with no renderable child: the compiler's degraded floor. The seam's
    // standing law is that a payload the renderer would reject is not a view.
    await save(APP_VENDO, `<App name="Empty"></App>`);
    expect(emitted).toEqual([]);
  });
});

describe("the description schema (§3.3)", () => {
  const description = {
    formatVersion: VENDO_SCREEN_FORMAT,
    root: "root",
    nodes: [{ id: "root", component: "Stack", children: [] }],
  };

  it("refuses `data` — the channel carries what to fetch, never what came back", () => {
    const parsed = screenDescriptionSchema.safeParse({
      ...description,
      data: { spending: [{ amount: 12 }] },
    });
    expect(parsed.success).toBe(false);
  });

  it("takes queries — WHAT to fetch is part of the description", () => {
    const parsed = screenDescriptionSchema.safeParse({
      ...description,
      queries: [{ name: "spending", tool: "maple_transactions_list" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("takes the server-authoritative riders and refuses a bad display", () => {
    expect(screenDescriptionSchema.safeParse({
      ...description,
      streaming: false,
      dataUnavailable: true,
      display: "stage",
      inClient: { granted: true, versionHash: "sha256:abc" },
      pinDrift: [{ slot: "header", component: "PinnedHeader" }],
    }).success).toBe(true);
    // The shipped vocabulary is "inline" | "stage" — never "staged".
    expect(screenDescriptionSchema.safeParse({ ...description, display: "staged" }).success).toBe(false);
  });

  it("refuses an unregistered format tag — a version is a contained failure", () => {
    expect(screenDescriptionSchema.safeParse({ ...description, formatVersion: "vendo-genui/v3" }).success)
      .toBe(false);
  });

  it("lets an additive field through, so a newer server does not break an older renderer", () => {
    expect(screenDescriptionSchema.safeParse({ ...description, somethingLater: true }).success).toBe(true);
  });
});
