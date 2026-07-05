/**
 * Shared view materialization (remix fast-edits epic): the validate → host-prop
 * check → compile → mint-node pipeline that `render_view` has always run, now
 * also the tail of `edit_view`. Validation runs on the AUTHORED payload (name
 * and cap checks apply to authored source); compilation replaces each
 * component's source with sandbox-ready ESM before shipping.
 */
import {
  hostPropIssues,
  validateGeneratedPayload,
  type GeneratedPayload,
  type RegisteredComponent,
  type UINode,
} from "@vendoai/core";
import { compileComponentSource } from "./compile-component.js";

export type MaterializeResult =
  | { ok: true; node: UINode; authored: GeneratedPayload }
  | { ok: false; error: string };

export interface MaterializeOptions {
  /** F1 registry: enables server-side `source:"host"` validation. */
  components?: RegisteredComponent[] | undefined;
  /** Tag the minted node as a remix candidate for this anchor. */
  remixAnchorId?: string | undefined;
  mintId: () => string;
}

/** Validate an authored payload, compile its components, mint the UINode. */
export function materializeView(
  input: unknown,
  options: MaterializeOptions,
): MaterializeResult {
  const validation = validateGeneratedPayload(input);
  if (!validation.ok) {
    return { ok: false, error: `(${validation.error.code}): ${validation.error.message}` };
  }
  if (options.components) {
    const issues = hostPropIssues(validation.payload, options.components);
    if (issues.length > 0) {
      return { ok: false, error: `(host): ${issues.map((i) => i.message).join(" | ")}` };
    }
  }
  let shipped = validation.payload;
  if (validation.payload.components) {
    const compiled: Record<string, string> = {};
    for (const [name, src] of Object.entries(validation.payload.components)) {
      try {
        compiled[name] = compileComponentSource(src);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: `(compile): component "${name}": ${msg}` };
      }
    }
    shipped = { ...validation.payload, components: compiled };
  }
  const node: UINode = {
    id: options.mintId(),
    kind: "generated",
    payload: shipped,
    ...(options.remixAnchorId ? { remixAnchorId: options.remixAnchorId } : {}),
  };
  return { ok: true, node, authored: validation.payload };
}
