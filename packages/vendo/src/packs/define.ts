import type { Pack } from "@vendoai/core";

/**
 * Author a pack (build contract §5).
 *
 * It returns the value unchanged, and that is the point: it is a typing handle,
 * not a wrapper. Every rule a pack must obey — global names, collisions, tool
 * name shape — is enforced by the boot merge, where every pack arrives on the
 * same path. Nothing can be privileged by being constructed differently, which
 * is why `apps()` and `automations()` can be plain packs with no internal API.
 *
 * (Deliberately NOT named `definePackTool`/`buildVendoToolPack` — `@vendoai/agent`
 * already exports `buildVendoToolPack`/`VendoPackTool` for the BYO tool pack,
 * which is a different thing.)
 */
export const definePack = <P extends Pack>(pack: P): P => pack;
