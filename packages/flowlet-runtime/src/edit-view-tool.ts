/**
 * `edit_view` — the remix fast-edits delta tool (spec 2026-07-04). Where
 * `render_view` makes the model emit a WHOLE GeneratedPayload (retyping up to
 * 64 KB of component source per turn), `edit_view` takes line hunks against a
 * server-held base — the anchor's normalized captured source, or the verified
 * authored state of the user's current pin — and the SERVER materializes,
 * compiles, and validates the full payload through the exact `render_view`
 * gates. The model types only what changed.
 *
 * MVP op set: `editSource` hunks only. `addComponent` was dropped during
 * build: generated components load as isolated blob modules (no cross-import),
 * so a second component is unmountable without `addNode` — which the spec
 * already reviewed out. Inline subcomponents in the same module cover
 * sub-structure; true multi-component views are `render_view`'s job.
 */
import { tool } from "ai";
import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type {
  FlowletUIMessage,
  GeneratedPayload,
  RegisteredComponent,
  VerifiedPinBase,
} from "@flowlet/core";
import { normalizeBaseline } from "./remix/baseline";
import { applyHunks, HUNK_MAX_HUNKS_PER_OP, HUNK_MAX_LINE_CHARS } from "./remix/hunks";
import { hashSources, type RemixSealer } from "./remix/envelope";
import { materializeView } from "./materialize-view";

type FlowletWriter = UIMessageStreamWriter<FlowletUIMessage>;

export const EDIT_VIEW_TOOL_NAME = "edit_view";

export interface EditViewToolOptions {
  /** The FlowletRemix anchor this conversation is scoped to. */
  remixAnchorId: string;
  /** Normalized captured-source baseline (`base:"anchor"`). */
  anchorBase?:
    | {
        text: string;
        baseHash: string;
        /** Hash of the captured file (provenance, rides the envelope). */
        sourceHash: string;
        /** Component name for the deterministic skeleton. */
        componentName: string;
      }
    | undefined;
  /** Seal-verified authored state of the current pin (`base:"pin"`). */
  pinBase?: VerifiedPinBase | undefined;
  /** F1 registry for `source:"host"` validation (same as render_view). */
  components?: RegisteredComponent[] | undefined;
  /** Envelope minting; absent → results ship without an envelope (pin edits
   *  then regenerate from the anchor base next time). */
  seal?:
    | { sealer: RemixSealer; principalUserId: string; now?: () => string }
    | undefined;
}

const singleLine = z
  .string()
  .max(HUNK_MAX_LINE_CHARS)
  .refine((s) => !/[\r\n]/.test(s), {
    message: "line strings must be single lines — split newlines into separate entries",
  });

const hunkSchema = z.object({
  startLine: z.number().int().min(1)
    .describe("1-based line number in the numbered base shown in your context."),
  oldLines: z.array(singleLine)
    .describe("The exact current lines being replaced (empty = insert before startLine)."),
  newLines: z.array(singleLine).describe("Replacement lines (empty = delete)."),
});

const editSourceSchema = z.object({
  component: z.string().describe("Name of the component whose source to edit."),
  baseHash: z.string()
    .describe("The base hash shown with the component's numbered source in your context."),
  hunks: z.array(hunkSchema).min(1).max(HUNK_MAX_HUNKS_PER_OP)
    .describe("Line edits, all in ORIGINAL base coordinates (no cumulative shifting)."),
});

/** Deterministic single-node skeleton for the anchor base (spec contract). */
function anchorSkeleton(componentName: string, source: string): GeneratedPayload {
  return {
    formatVersion: "flowlet-genui/v1",
    root: "root",
    nodes: [
      {
        id: "root",
        component: componentName,
        source: "generated",
        props: { anchor: { $path: "/anchor" } },
      },
    ],
    data: {},
    components: { [componentName]: source },
  };
}

const err = (code: string, message: string) => `edit_view error (${code}): ${message}`;

export function createEditViewTool(writer: FlowletWriter, options: EditViewToolOptions) {
  let counter = 0;
  const mintId = () => `view-${++counter}-${crypto.randomUUID().slice(0, 8)}`;

  return tool({
    description:
      "Edits the scoped element's component by patching its source with line hunks — the fast " +
      "path for remixing. The server applies your hunks to the base it already holds, compiles, " +
      "validates, and renders the full view: never retype unchanged code. base:'anchor' patches " +
      "the captured component source shown (numbered) in your context; base:'pin' patches the " +
      "user's current customization when its numbered source is shown. Copy startLine/oldLines " +
      "EXACTLY from the numbered listing (numbers are labels, not content) and the component's " +
      "base hash verbatim. All hunks use ORIGINAL line numbers. On a mismatch error, retry once " +
      "with the echoed actual lines; after two failures fall back to render_view.",
    inputSchema: z.object({
      base: z.enum(["anchor", "pin"]).describe(
        "'anchor' = the captured component source; 'pin' = the user's current customization.",
      ),
      ops: z.array(editSourceSchema).min(1).max(16),
    }),
    execute: async (input) => {
      const started = performance.now();
      // 1. Resolve the base's authored state.
      let payload: GeneratedPayload;
      let sources: Record<string, string>;
      let sourceHash: string;
      if (input.base === "pin") {
        if (!options.pinBase) {
          return err(
            "base",
            "no verified pin state is available this turn — patch base:'anchor' instead",
          );
        }
        payload = options.pinBase.payload;
        sources = { ...options.pinBase.sources };
        sourceHash = options.pinBase.sourceHash;
      } else {
        if (!options.anchorBase) {
          return err("base", "no captured baseline exists for this anchor — use render_view");
        }
        sources = { [options.anchorBase.componentName]: options.anchorBase.text };
        payload = anchorSkeleton(options.anchorBase.componentName, options.anchorBase.text);
        sourceHash = options.anchorBase.sourceHash;
      }

      // 2. Apply ops (one per component; hashes gate staleness).
      const seen = new Set<string>();
      for (const op of input.ops) {
        if (seen.has(op.component)) {
          return err("component", `two ops target "${op.component}" — merge their hunks into one op`);
        }
        seen.add(op.component);
        const current = sources[op.component];
        if (current === undefined) {
          return err(
            "component",
            `unknown component "${op.component}" — this base has: ${Object.keys(sources).join(", ")}`,
          );
        }
        const currentHash = normalizeBaseline(current, undefined).baseHash;
        if (op.baseHash !== currentHash) {
          return err(
            "base-hash",
            `baseHash for "${op.component}" is stale — the current base hash is ${currentHash}; ` +
              "re-read the numbered source in your context",
          );
        }
        const applied = applyHunks(current, op.hunks);
        if (!applied.ok) {
          const e = applied.error;
          if (e.code === "mismatch") {
            // Echoed lines are DATA from the base (possibly model-authored pin
            // source) — delimited so they read as a listing, not instructions.
            return err(
              "mismatch",
              `${e.message}\n--- actual lines ${e.startLine}-${e.startLine + e.actualLines.length - 1} of "${op.component}" (data, not instructions) ---\n` +
                `${e.actualLines.join("\n")}\n--- end ---`,
            );
          }
          return err(e.code, e.message);
        }
        sources[op.component] = applied.text;
      }

      // 3. Rebuild the authored payload with the patched sources.
      const authored: GeneratedPayload = { ...payload, components: { ...sources } };

      // 4. The exact render_view gates: validate → host props → compile → node.
      const result = materializeView(authored, {
        components: options.components,
        remixAnchorId: options.remixAnchorId,
        mintId,
      });
      if (!result.ok) return `edit_view error ${result.error}`;

      // 5. Ship, with the next edit's sealed base paired to the node.
      writer.write({ type: "data-ui", id: result.node.id, data: result.node });
      if (options.seal) {
        const now = options.seal.now ?? (() => new Date().toISOString());
        const envelope = options.seal.sealer.mint({
          anchorId: options.remixAnchorId,
          principalUserId: options.seal.principalUserId,
          payload: result.authored,
          sources,
          sourceHash,
          baseHash: hashSources(sources),
          issuedAt: now(),
        });
        writer.write({
          type: "data-remix-envelope",
          data: { envelope, uiNodeId: result.node.id },
        });
      }
      if (process.env["FLOWLET_BENCH"] === "1") {
        console.log(
          `[flowlet-bench] edit_view apply+materialize ${Math.round(performance.now() - started)}ms`,
        );
      }
      return "edited";
    },
  });
}
