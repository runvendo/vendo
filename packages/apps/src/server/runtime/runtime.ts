import { createAccessSurface } from "../doors/access-surface.js";
import { createAppsSurface } from "../doors/apps-surface.js";
import { createBuildSurface } from "../doors/build-surface.js";
import { createInClientSurface } from "../doors/inclient-surface.js";
import { createMachineSurface, createServedDoors } from "../doors/machine-surface.js";
import { createPinsSurface } from "../remix/seed-surface.js";
import { createPlacementSurface } from "../doors/placement-surface.js";
import { createReviewSurface } from "../doors/review-surface.js";
import { createRuntimeContext } from "./runtime-context.js";
import { createWriteSurface } from "../doors/write-surface.js";
import type { AppsConfig, AppsRuntime } from "./types.js";

// 06-apps §1 — the block's type surface moved to types.ts (the contract and its
// implementation used to sit ~2,000 lines apart in this file). Re-exported here
// because `./runtime.js` is where the package's existing importers name them.
export type {
  AppsConfig,
  AppsRuntime,
  AuthoredAppResult,
  BoxRequest,
  BoxResponse,
  EditFailure,
  EditResult,
  OpenSurface,
  PinForkInput,
  PinForkResult,
  PinRebaseResult,
  PlacementEntry,
  VersionEntry,
} from "./types.js";
// …and the values, for the same reason: the build sentences and the failure
// classifier moved to build-messages.ts, the payload assembler to build-surface.ts.
export {
  NO_ASSEMBLER,
  NOTHING_RENDERABLE,
  NO_MACHINE,
  buildFailureReason,
} from "../doors/build-messages.js";
export { assembleTree } from "../doors/build-surface.js";

/**
 * 06-apps §1 — construct the app lifecycle, generation, execution, and
 * interchange surface.
 *
 * An assembler, and nothing else: `createRuntimeContext` wires the closure
 * (runtime-context.ts), and every door below is a module returning its slice of
 * `AppsRuntime`. `runtime` is passed as a thunk because `pins.fork` re-enters
 * the public doors while this object literal is still forming.
 */
export const createApps = (config: AppsConfig): AppsRuntime => {
  const ctx = createRuntimeContext(config, () => runtime);
  const runtime: AppsRuntime = {
    ...createBuildSurface(ctx),
    ...createWriteSurface(ctx),
    ...createAppsSurface(ctx),
    ...createPlacementSurface(ctx),
    ...createServedDoors(ctx),
    access: createAccessSurface(ctx),
    slots: ctx.slots,
    inClient: createInClientSurface(ctx),
    review: createReviewSurface(ctx),
    pins: createPinsSurface(ctx),
    machine: createMachineSurface(ctx),
  };
  return runtime;
};
