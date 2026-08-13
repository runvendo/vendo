/** The credential resolver moved to `@vendoai/harnesses/inference/credential`
 *  with the rest of the ladder. It keeps its own subpath because it is the
 *  PURE half — no node builtins — and the boot summary reads `ENV_KEY_VARS`
 *  from a graph that has to bundle for a Worker. */
export {
  describeDevCredential,
  ENV_KEY_VARS,
  resolveDevCredential,
  type DevCredential,
  type EnvKeyProvider,
  type ResolveDevCredentialOptions,
} from "@vendoai/harnesses/inference/credential";
