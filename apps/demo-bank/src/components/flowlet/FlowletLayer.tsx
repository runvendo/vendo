"use client";

/**
 * The Flowlet layer dropped over Maple. A single client island that owns the
 * shared agent session and renders every embed surface. Mounted once in the root
 * layout so it floats above the untouched bank UI — the "we dropped in one
 * layer" thesis, literally.
 */
import { FlowletRoot } from "./FlowletRoot";
import { FlowletDock } from "./FlowletDock";

export function FlowletLayer() {
  return (
    <FlowletRoot>
      <FlowletDock />
    </FlowletRoot>
  );
}
