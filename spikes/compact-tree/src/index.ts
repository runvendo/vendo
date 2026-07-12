/**
 * @vendoai/spike-compact-tree — SPIKE ONLY.
 *
 * Prototypes of two compact encodings for the pinned `vendo-genui/v1` tree, to
 * test whether the app-format spec §7 "token-compact wire profile" pays off for
 * OUR tree. Nothing here is registered in @vendoai/core, and no wire format is
 * changed. Output is evidence + a recommendation (see DESIGN.md).
 */
export { canonicalize } from "./canonicalize.js";
export {
  encodeCjt,
  decodeCjt,
  encodeCjtString,
  decodeCjtString,
  type CjtDocument,
} from "./profile-cjt.js";
export { encodeVtl, decodeVtl } from "./profile-vtl.js";
