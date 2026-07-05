/**
 * Node ESM loader hook used only by drill-persistence-store.mjs.
 *
 * @vendoai/store's compiled dist writes relative imports WITH explicit ".js"
 * extensions (its source already spells them that way — it's designed to run
 * standalone under plain Node, per Task 6/19 of the persistence plan). But its
 * declared runtime dependency @vendoai/runtime (and, transitively,
 * @vendoai/core) do NOT: their dist output carries bundler-style extensionless
 * relative imports (e.g. `from "./engine"`), which only resolve through a
 * bundler (webpack/Turbopack/vite) or a resolution-tolerant test runner
 * (vitest) — not plain Node ESM. This is the same gap vendo-cli's own
 * bins already work around by vite-bundling instead of running dist directly
 * (see packages/vendo-cli's bundle-assets step).
 *
 * Rather than change those packages' build output (a repo-wide, cross-cutting
 * decision out of scope for this drill), this hook retries a failed relative
 * resolution with ".js" appended — the same normalization a bundler performs.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const code = err && typeof err === "object" ? err.code : undefined;
    if (isRelative && code === "ERR_MODULE_NOT_FOUND" && !specifier.endsWith(".js") && !specifier.endsWith(".json")) {
      return await nextResolve(`${specifier}.js`, context);
    }
    // Extensionless directory imports (e.g. `from "./policy"` meaning
    // `./policy/index.js`) — the other bundler-style resolution shorthand.
    if (isRelative && code === "ERR_UNSUPPORTED_DIR_IMPORT") {
      return await nextResolve(`${specifier}/index.js`, context);
    }
    throw err;
  }
}
