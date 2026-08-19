/**
 * ONE PORT, ONE DIALECT — and the paint that says so.
 *
 * A port is real host source, so it carries the host's own classes, and
 * `className` is a DIALECT rather than a prop: the typings print it for a port
 * and print nothing for a screen a model wrote. `vendo sync` grades a port in
 * that dialect. The runtime floor has to grade the same bytes in the same one,
 * or a component the host's sync blessed is refused the moment somebody forks it
 * — which is what happened while the two configurations were assembled twice.
 *
 * So this test crosses the fence rather than mocking either side of it: the real
 * `vendoSync` emits the port, the real `seed.from` puts it through the real
 * checks floor, and the real floor door paints it. Nothing hand-writes a
 * baseline and nothing calls the gauntlet directly — a harness that graded the
 * port itself could never disagree with sync.
 *
 * The two that must be able to fail:
 *  - drop `AppFloorOptions.ported` (apps checking/floor.ts) and the seed goes red
 *    on the stored screen, with the floor's own `className` sentence.
 *  - drop the paint's `source` (apps checking/component-screen.ts) and the last
 *    assertion goes red — the class then reaches no DOM node, because a brick
 *    paints one for a `source: "ported"` node and for nothing else.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vendoSync } from "@vendoai/actions/sync";
import { SCREEN_FILE, seedBaselineSchema } from "@vendoai/apps";
import { SCREEN_TEXT_NODE } from "@vendoai/apps/contract";
import type { RunContext } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo } from "../src/server.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_port_dialect" },
  venue: "app",
  presence: "present",
  sessionId: "session_port_dialect",
};

const originalCwd = process.cwd();
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  process.chdir(originalCwd);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a styled port is graded in one dialect from sync to paint", () => {
  it("blesses the host's own classes at sync, admits the same bytes at the floor, and stamps the paint ported", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-port-dialect-"));
    cleanups.push(async () => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "src"), { recursive: true });
    // Styled the way every real host component is styled. Without the ported
    // dialect this line alone is what the floor refuses.
    await writeFile(join(root, "src", "MapleBalanceCard.tsx"), `export default function MapleBalanceCard() {
  return <article className="maple-card"><strong className="maple-total">$1.2M</strong></article>;
}
`);
    await writeFile(join(root, "src", "page.tsx"), `
import { Remixable } from "@vendoai/ui/chrome";
import MapleBalanceCard from "./MapleBalanceCard";
export default function Page() {
  return <Remixable><MapleBalanceCard /></Remixable>;
}
`);

    await vendoSync({ root, out: join(root, ".vendo") });
    const baseline = seedBaselineSchema.parse(JSON.parse(
      await readFile(join(root, ".vendo", "remixable", "MapleBalanceCard.json"), "utf8"),
    ));
    const port = baseline.ported;
    if (port === undefined) throw new Error("sync did not port a styled component");
    expect(port.source).toContain('className="maple-card"');

    const store = createStore({ dataDir: join(root, ".data") });
    cleanups.push(async () => store.close());
    await store.ensureSchema();
    process.chdir(root);
    // No model: the instruction riding the gesture fails harmlessly, and what is
    // measured is the seed BEFORE it — the port through the floor.
    const vendo = createVendo({ principal: async () => ctx.principal, store, development: true });

    const app = await vendo.apps.seed.from(
      { component: "MapleBalanceCard", instruction: "make the total bigger" },
      ctx,
    );
    // The floor admitted the port: a refusal stores no screen at all and leaves
    // the floor's own sentence on the row instead, so the pair reads as the
    // floor's words on the day the two grades drift apart again.
    const stored = await vendo.apps.get(app.id, ctx);
    expect(stored?.buildFailed?.reason ?? "").not.toContain("did not pass the checks floor");
    expect(stored?.source?.[SCREEN_FILE]?.text).toContain('className="maple-card"');

    // The same door the reopen paints through (`saves: false` — a read). Every
    // node it emits says where the screen came from, which is the only thing that
    // lets a display brick paint a host class.
    const painted = await vendo.apps.floor(ctx, { saves: false }).component({ appId: app.id, source: port.source });
    if (!painted.ok) throw new Error(painted.blocking.join("; "));
    const sources = new Set(Object.values(painted.nodes)
      .filter(({ component }) => component !== SCREEN_TEXT_NODE)
      .map(({ source }) => source));
    expect([...sources]).toEqual(["ported"]);
  }, 120_000);
});
