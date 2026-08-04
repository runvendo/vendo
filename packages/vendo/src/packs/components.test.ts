/**
 * The CLIENT half of a pack (F7). Design §5: a pack module is imported twice —
 * once by `createVendo({ packs })` for its tools, checks and skills, once by the
 * client root, which mounts its components. Without this, "one config line" is
 * two and the render half of every pack is dead.
 */
import { describe, expect, it } from "vitest";
import { definePack } from "./define.js";
import { packComponents } from "./components.js";
import type { PackContext } from "./merge.js";

const Badge = { displayName: "RetentionBadge" };
const Chip = { displayName: "Chip" };

const withBadge = definePack({
  name: "compliance-reports",
  components: { RetentionBadge: { component: Badge, description: "Retention." } },
});

describe("packComponents", () => {
  it("collects the components of every pack, keyed by name", () => {
    const merged = packComponents([
      withBadge,
      definePack({ name: "chips", components: { Chip: { component: Chip, description: "A chip." } } }),
    ]);

    expect(Object.keys(merged).sort()).toEqual(["Chip", "RetentionBadge"]);
    expect(merged.RetentionBadge?.component).toBe(Badge);
  });

  it("collects nothing from a pack with no components", () => {
    expect(packComponents([definePack({ name: "toolsy" })])).toEqual({});
  });

  it("collects nothing from no packs", () => {
    expect(packComponents([])).toEqual({});
  });

  it("resolves a pack authored as a function of the boot context", () => {
    // `apps()` is one of these. The client cannot build a real context, and a
    // well-formed pack never touches it while being constructed — only inside a
    // tool's execute — so reading its components on the client is safe.
    const provider = (_context: PackContext) => withBadge;

    expect(Object.keys(packComponents([provider]))).toEqual(["RetentionBadge"]);
  });

  it("fails loudly and specifically if a pack reaches for the runtime at construction", () => {
    const badlyWritten = (context: PackContext) => {
      context.apps();
      return withBadge;
    };

    expect(() => packComponents([badlyWritten])).toThrow(/browser|client/i);
  });

  it("names the offending entry when the list holds something that is not a pack", () => {
    // A stray comma or a failed import, not a bug in a pack — say which slot.
    expect(() => packComponents([withBadge, undefined as never])).toThrow(/packs\[1\]/);
    expect(() => packComponents([null as never])).toThrow(/packs\[0\][\s\S]*null/);
    expect(() => packComponents(["nope" as never])).toThrow(/packs\[0\]/);
  });

  it("lets the LAST pack win a component name, matching the server's merge order", () => {
    const rival = definePack({
      name: "rival",
      components: { RetentionBadge: { component: Chip, description: "Mine." } },
    });

    expect(packComponents([withBadge, rival]).RetentionBadge?.component).toBe(Chip);
  });
});
