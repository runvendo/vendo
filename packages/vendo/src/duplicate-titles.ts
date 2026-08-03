import { duplicateToolTitles, VendoError, type ToolDescriptor, type ToolRegistry } from "@vendoai/core";
import { FIND_TOOLS_TOOL_NAME } from "@vendoai/agent";

/**
 * Design §12 — "two actions must never read identically on a card."
 *
 * A consent card shows a tool's `title`. If two tools share one, the card cannot
 * tell the person which action they are approving, and `title` is part of the
 * descriptorHash they consented to — so the ambiguity is not cosmetic, it is a
 * consent defect. The contract calls for a BOOT error.
 *
 * `createVendo` is synchronous while the descriptor set is resolved lazily and
 * asynchronously (the portability gate forbids I/O at module scope, so
 * `actions.descriptors()` cannot be awaited at compose). Composition therefore
 * INSTALLS this check, and it fires the instant the descriptor set first becomes
 * known — the earliest moment the fact is knowable at all. A bad deployment
 * fails every call that needs tools and never becomes healthy on retry.
 *
 * The check is memoized per registry: every turn enumerates descriptors, and a
 * whole-registry title scan on that hot path would be waste for a fact that
 * cannot change without a redeploy.
 *
 * The scan runs over the FULL, UNPROJECTED tool set — `tools.descriptors()` with
 * NO context — never over a per-run projection. Title uniqueness is a deployment
 * property: two identically-titled tools collide whether or not a given run is
 * allowed to see both of them. Memoizing a verdict computed against a projected
 * set was a real hole: an unattended tick projects away the two DESTRUCTIVE
 * tools that collide, the collision vanishes from that set, and a "clean" verdict
 * gets cached — after which an attended execute short-circuits and runs a
 * mutating call under an ambiguous consent card.
 */
export function withUniqueToolTitles(tools: ToolRegistry): ToolRegistry {
  let verdict: VendoError | undefined;
  let checked = false;

  const assertUnique = async (): Promise<void> => {
    if (!checked) {
      // The full deployment surface, deliberately unprojected. Any ctx would
      // narrow it and reintroduce the hole this replaced.
      const descriptors = await tools.descriptors();
      checked = true;
      // A host tool that takes a reserved internal name is a DEPLOYMENT fault, so
      // it belongs here with the title check rather than surfacing as a mid-turn
      // stream throw the user sees as a broken conversation. `find_tools` carries
      // no `vendo_` prefix, so nothing else would catch it.
      const reserved = descriptors.find((descriptor) => descriptor.name === FIND_TOOLS_TOOL_NAME);
      if (reserved !== undefined) {
        verdict = new VendoError(
          "conflict",
          `A host tool is named ${JSON.stringify(FIND_TOOLS_TOOL_NAME)}, which Vendo reserves for its own `
          + "tool-discovery meta-tool. Rename it in .vendo/overrides.json.",
        );
      }
      const collisions = duplicateToolTitles(descriptors);
      if (verdict === undefined && collisions.length > 0) {
        const detail = collisions
          .map(({ title, tools: names }) => `"${title}" (${names.join(", ")})`)
          .join("; ");
        verdict = new VendoError(
          "conflict",
          `Two or more tools share one title, so a consent card cannot tell them apart: ${detail}. `
          + "Retitle them in .vendo/overrides.json — a title is what the user approves.",
        );
      }
    }
    if (verdict !== undefined) throw verdict;
  };

  return {
    ...tools,
    async descriptors(ctx) {
      await assertUnique();
      return tools.descriptors(ctx);
    },
    // EXECUTION is gated too. Gating only enumeration was a hole, not a
    // simplification: a caller holding a tool name from anywhere else — a stored
    // app document, a replayed approval, a compound step — could still perform a
    // real mutating call on a deployment whose consent cards cannot tell two
    // actions apart. The card is the only thing standing between the user and an
    // irreversible action, so if it is ambiguous nothing may run.
    async execute(call, ctx) {
      await assertUnique();
      return tools.execute(call, ctx);
    },
  };
}
