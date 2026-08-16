/**
 * A route a generated screen names, measured against the registry the HOST
 * registered — at generation, not at render.
 *
 * `resolveVendoRoute` already refuses an unregistered name when the brick paints
 * (it falls back to plain text), and that is the silent break: the model wrote a
 * way out of the screen, the person got dead words, and every stage said the
 * screen was fine. So the refusal moves to where it can still be repaired.
 *
 * Driven through the REAL floor — `createApps({ routes })` → `floor(ctx).component`,
 * the same door composition hands the render seam — because the value of this
 * check is entirely in whether the host's registry actually reaches it. A test
 * that handed the registry to the checker by hand would pass with the umbrella's
 * wiring cut.
 */
import {
  type AppId,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import {
  kitSpec,
  renderBriefingPack,
  type NormalizedCatalog,
  type VendoRouteMap,
} from "../../src/contract/index.js";
import { createApps } from "../../src/server/index.js";
import { guardFixture } from "../../src/server/testing/guard-fixture.js";
import { memoryStore } from "../../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../../src/server/testing/scripted-model.js";

const routes: VendoRouteMap = {
  accounts: { path: "/accounts", description: "Every account, with its balance." },
  account: { path: "/accounts/:id", description: "One account by id, and its transactions." },
};

const screen = (to: string, params = "") => `import { Link, Stack, Text } from "@vendo/screen";

export default function Wayfinding() {
  return (
    <Stack>
      <Text text="Your balance moved." />
      <Link to="${to}"${params} label="Take me there" />
    </Stack>
  );
}
`;

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() { return []; },
  async execute() { return { status: "error", error: { code: "not-found", message: "no tools" } }; },
};

const catalog: NormalizedCatalog = [];

/** The floor as composition hands it over, with the host's registry in the slot
 *  `createVendo({ routes })` fills. */
const paint = async (source: string, registry?: VendoRouteMap) => {
  const apps = createApps({
    store: memoryStore(),
    guard: guardFixture(),
    tools,
    catalog,
    model: scriptedLanguageModel(() => "no"),
    ...(registry === undefined ? {} : { routes: registry }),
  });
  return apps.floor(ctx).component({ appId: `app_link_${Math.random().toString(36).slice(2)}` as AppId, source });
};

const blocking = (painted: Awaited<ReturnType<typeof paint>>): string =>
  painted.ok ? "" : painted.blocking.join("\n");

describe("the floor refuses a route the host never registered", () => {
  it("names the route AND the component, and lists what this host really has", async () => {
    const painted = await paint(screen("admin_panel"), routes);

    expect(painted.ok, "an unregistered route reached a screen").toBe(false);
    const said = blocking(painted);
    expect(said).toContain('names route "admin_panel" on <Link>');
    expect(said).toContain("which this host never registered");
    // The repair is always "pick another of these" — the registry is the model's
    // whole vocabulary here, so the message hands it over.
    expect(said).toContain("The registered routes are: accounts, account");
    expect(said).toContain("it never writes a URL");
  }, 60_000);

  it("lets a registered route through the same door", async () => {
    expect(blocking(await paint(screen("accounts"), routes))).toBe("");
  }, 60_000);

  it("refuses EVERY link when the host registered an empty registry", async () => {
    const painted = await paint(screen("accounts"), {});

    expect(painted.ok).toBe(false);
    expect(blocking(painted)).toContain("registered no routes at all");
  }, 60_000);

  it("stays silent for a host that registered no registry at all, exactly as `tools` does", async () => {
    expect(blocking(await paint(screen("accounts")))).toBe("");
  }, 60_000);

  it("refuses a REGISTERED route whose :params the link left unfilled, naming which", async () => {
    // The second way a link dies quietly, and the reason it lives in this check
    // rather than its own: `resolveVendoRoute` answers undefined here too, and
    // the brick renders the identical dead text.
    const painted = await paint(screen("account"), routes);

    expect(painted.ok, "a link with no value for :id reached a screen").toBe(false);
    const said = blocking(painted);
    expect(said).toContain('names route "account" on <Link> but leaves "id" unfilled');
    expect(said).toContain("that route's path takes :id");
    // Someone reading it knows what to type next.
    expect(said).toContain('Write params={{ id: … }} beside to="account"');
  }, 60_000);

  it("names ONLY the params that are missing, not every one the path takes", async () => {
    const twoParams: VendoRouteMap = {
      entry: { path: "/accounts/:id/entries/:entryId", description: "One ledger entry." },
    };
    const painted = await paint(screen("entry", ' params={{ id: "acc_1" }}'), twoParams);

    expect(painted.ok).toBe(false);
    const said = blocking(painted);
    expect(said).toContain('leaves "entryId" unfilled');
    expect(said).not.toContain('"id", "entryId"');
    // The full shape of the path still gets stated, so the repair has context.
    expect(said).toContain("takes :id, :entryId");
  }, 60_000);

  it("lets a link through once every :param has a value", async () => {
    expect(blocking(await paint(screen("account", ' params={{ id: "acc_1" }}'), routes))).toBe("");
  }, 60_000);

  it("ACCEPTS a route whose path carries a literal colon in a segment", async () => {
    // A colon is legal in a path segment, and reading `/reports/2026:Q3` as
    // taking a `Q3` parameter refused a screen whose link was perfectly good.
    const literal: VendoRouteMap = {
      quarter: { path: "/reports/2026:Q3", description: "The Q3 report." },
    };
    expect(blocking(await paint(screen("quarter"), literal))).toBe("");
  }, 60_000);

  it("still refuses a real :param beside a literal colon", async () => {
    const mixed: VendoRouteMap = {
      section: { path: "/reports/2026:Q3/:sectionId", description: "One section of it." },
    };
    const said = blocking(await paint(screen("section"), mixed));
    expect(said).toContain('leaves "sectionId" unfilled');
    // The literal is not advertised as a blank to fill.
    expect(said).not.toContain("Q3");
    expect(blocking(await paint(screen("section", ' params={{ sectionId: "s_1" }}'), mixed))).toBe("");
  }, 60_000);

  it("keeps the checker pinned to the brick that takes a route", () => {
    // The check reads `<Link to>` by name. If the brick is ever renamed or loses
    // its `to`, this fails here rather than going quietly unenforced.
    expect(kitSpec("Link")?.props?.to).toBeDefined();
  });
});

describe("what the writer is told about the routes", () => {
  it("teaches the NAMES and the params to fill — and never a path", () => {
    const rendered = renderBriefingPack({ catalog: [], hostSemantics: "", routes });

    expect(rendered).toContain("ROUTES (this product's own pages");
    expect(rendered).toContain("- accounts: Every account, with its balance.");
    expect(rendered).toContain("- account: One account by id, and its transactions. (fill params: id)");
    // THE security property of this section. A path in the prompt is a URL for
    // the model to copy, and generated output must only ever SELECT a key: the
    // host spells every address, through `onNavigate`.
    expect(rendered).not.toContain("/accounts");
  });

  it("does not advertise a literal colon as a param the host must fill", () => {
    const rendered = renderBriefingPack({
      catalog: [],
      hostSemantics: "",
      routes: {
        quarter: { path: "/reports/2026:Q3", description: "The Q3 report." },
        section: { path: "/reports/2026:Q3/:sectionId", description: "One section of it." },
      },
    });

    // The whole failure in one line: a blank the host can never fill.
    expect(rendered).toContain("- quarter: The Q3 report.");
    expect(rendered).not.toContain("fill params: Q3");
    // The real parameter beside it is still taught.
    expect(rendered).toContain("- section: One section of it. (fill params: sectionId)");
  });

  it("says nothing at all when the host registered no pages", () => {
    expect(renderBriefingPack({ catalog: [], hostSemantics: "" })).not.toContain("ROUTES");
    expect(renderBriefingPack({ catalog: [], hostSemantics: "", routes: {} })).not.toContain("ROUTES");
  });
});
