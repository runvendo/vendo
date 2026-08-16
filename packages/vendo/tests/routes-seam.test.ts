// The host's route registry, from `createVendo({ routes })` to the floor that
// enforces it. The registry has two readers — `<VendoProvider routes>` resolves
// a press, and the checks floor refuses a screen that names a page the host
// never registered — and the whole value of the second one is that composition
// really hands it over. So this drives the REAL composed floor: a one-line
// spread that stopped happening would show up here as a screen that ships a
// link to nowhere, which is the exact failure the check exists to end.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppId, Principal, RunContext } from "@vendoai/core";
import type { VendoRouteMap } from "@vendoai/apps/contract";
import { createStore, type VendoStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_routes" };
const ctx: RunContext = { principal, venue: "app", presence: "present", sessionId: "session_routes" };

const routes: VendoRouteMap = {
  accounts: { path: "/accounts", description: "Every account, with its balance." },
};

const screen = (to: string) => `import { Link, Stack } from "@vendo/screen";

export default function Wayfinding() {
  return (
    <Stack>
      <Link to="${to}" label="Take me there" />
    </Stack>
  );
}
`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-routes-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const paint = async (to: string) => {
  const vendo = createVendo({ principal: async () => principal, store: await tempStore(), routes });
  // `saves: false` — the read half of the same floor: every stage is identical,
  // and the verdict is what is under test, not the row a passing paint earns.
  return vendo.apps.floor(ctx, { saves: false })
    .component({ appId: "app_routes_seam" as AppId, source: screen(to) });
};

describe("createVendo({ routes }) reaches the checks floor", () => {
  it("refuses a screen naming a page this host never registered", async () => {
    const painted = await paint("admin_panel");

    expect(painted.ok, "an unregistered route reached a screen").toBe(false);
    expect((painted as { blocking: readonly string[] }).blocking.join("\n"))
      .toContain('names route "admin_panel" on <Link>');
  }, 60_000);

  it("paints the same screen when it names a page the host did register", async () => {
    expect((await paint("accounts")).ok).toBe(true);
  }, 60_000);
});

describe("createVendo({ routes }) refuses a pattern the resolver cannot fill", () => {
  // A `:param` is a WHOLE path segment. `/posts/:slug.html` reported no
  // parameters at all, so `resolveVendoRoute` handed back a path still carrying
  // ":slug.html" even when the caller supplied `slug` — and because the checker
  // and the briefing share that parser, neither refused the route nor told
  // generation to provide the value. Silence, again. So it is refused at
  // REGISTRATION, where a host reads it once and fixes it.
  const compose = (routes: VendoRouteMap) => async () =>
    createVendo({ principal: async () => principal, store: await tempStore(), routes });

  it("refuses a suffix after the parameter, naming the route and the segment", async () => {
    await expect(compose({
      post: { path: "/posts/:slug.html", description: "One post." },
    })()).rejects.toThrow(/route "post".*"\/posts\/:slug\.html".*":slug\.html"/su);
  });

  it("tells the reader what is supported and what to write instead", async () => {
    const failed = await compose({
      account: { path: "/accounts/:id-2", description: "The second account." },
    })().then(() => undefined, (error: unknown) => error as Error);

    const said = failed?.message ?? "";
    expect(said).toContain("a :param must be a WHOLE path segment");
    expect(said).toContain('"/accounts/:id"');
    expect(said).toContain('"/accounts/:id-2"');
  });

  it("composes fine for a literal colon and for a whole-segment param", async () => {
    await expect(compose({
      quarter: { path: "/reports/2026:Q3", description: "The Q3 report." },
      account: { path: "/accounts/:id", description: "One account." },
      plain: { path: "/accounts", description: "Every account." },
    })()).resolves.toBeDefined();
  });
});
