/** The prop contract for the wire's built-in components, surfaced to the
 *  validator.
 *
 *  The model receives full prop schemas for HOST catalog components; the
 *  built-ins are taught by `kitPrompt()` from the same specs this reads. The
 *  compiler keeps any attribute the model writes, so a wrong name (`data` for
 *  DataTable's `rows`, `onPress` for Button's `onClick`, `labelKey` on Select)
 *  would survive into props and be silently dropped at render — this map is
 *  what the floor rejects them against.
 *
 *  SOURCE OF TRUTH: `KIT_SPECS` in `@vendoai/core`. V4 retired the legacy
 *  prewired/branded family, so there is nothing left to hand-write here. */
import {
  KIT_SCREEN_COMPONENT_NAMES,
  kitPropClasses,
} from "../../contract/index.js";

/** Allowed prop-name set per wire built-in, for validation. */
export const wirePropNames: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  KIT_SCREEN_COMPONENT_NAMES.map((name) =>
    [name, new Set(Object.keys(kitPropClasses(name) ?? {}))] as const),
);
