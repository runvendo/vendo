/**
 * The client half of the pack merge: the `components` slot, and nothing else.
 *
 * A pack module is **imported twice** (design §5) — the server reads its tools,
 * checks and skills; the client root mounts its components. This is the client
 * side of that, and it is a separate file from the boot merge for one hard
 * reason: it must not pull a server block into a browser bundle. It imports
 * types only.
 *
 * The other three slots are deliberately ignored here. A pack's tools execute on
 * our side, its checks run on our side, and its skills live in the workspace; the
 * browser has no business with any of them.
 */
import type { ComponentRegistry, Pack, PackProvider } from "@vendoai/core";
import type { PackContext } from "./merge.js";

/**
 * The context a pack sees when it is being read for its components in a browser.
 *
 * Every member throws. A pack authored as a function of the boot context may
 * CLOSE OVER the handle — that is how a tool reaches the apps runtime at call
 * time — but it must never call it while being constructed, because construction
 * happens on both sides. One that does gets told exactly that, instead of a
 * confusing undefined somewhere downstream.
 */
const clientContext: PackContext = {
  apps: () => {
    throw new Error(
      "a pack read its platform handle while being constructed, which cannot work in the browser: the client imports pack modules to mount their components, and the apps runtime only exists on the server. Reach for the handle inside a tool's execute (a thunk), never at the top of the pack.",
    );
  },
};

const resolve = (provider: PackProvider<PackContext>, index: number): Pack => {
  if (typeof provider === "function") return provider(clientContext);
  // Named rather than a bare TypeError two frames deep: the likely cause is a
  // stray comma or a failed import in the host's `packs` array, and the index is
  // what points at it.
  if (provider === null || typeof provider !== "object") {
    throw new Error(
      `packs[${index}] is ${provider === null ? "null" : typeof provider} rather than a pack. Each entry is either a pack value from definePack(...) or a function returning one — check for a stray comma or an import that did not resolve.`,
    );
  }
  return provider;
};

/**
 * The components every configured pack contributes, ready to hand to the
 * provider's `components` prop.
 *
 * Later packs win a repeated name, which is the same precedence the server's
 * catalog merge gives them, so the two halves of one `packs:` list can never
 * disagree about which component a name means.
 */
export const packComponents = (
  providers: readonly PackProvider<PackContext>[],
): ComponentRegistry => {
  const components: ComponentRegistry = {};
  for (const [index, provider] of providers.entries()) {
    Object.assign(components, resolve(provider, index).components ?? {});
  }
  return components;
};
