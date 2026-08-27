/**
 * The two things the shell has to ask the RUNTIME instead of assuming: whether
 * it can host a worker thread, and where its own libraries actually live.
 */

/**
 * Can this runtime host a worker thread?
 *
 * `js-exec` runs QuickJS inside `node:worker_threads` — the only part of the
 * shell that is Node-only. Everywhere else (an edge runtime, a Worker) the shell
 * is still the whole shell: bash, the coreutils, the parsers. So the answer is a
 * capability question asked once, not a deployment flag anyone has to set.
 *
 * Asked through `process.getBuiltinModule` rather than a static import, for the
 * same reason `dot-vendo.ts` reads `node:fs` that way: this module carries NO
 * static Node import and therefore still loads and bundles for edge/Worker
 * targets, where the accessor is simply absent.
 *
 * The accessor itself landed in Node 20.16 / 22.3, so on the sliver of the
 * `>=20` engines range below that this answers no while `node:worker_threads` is
 * in fact there, and js-exec stays off. Deliberate: every alternative reaches for
 * a static `node:` import or sniffs `process.versions`, and the first breaks the
 * edge bundling this exists for while the second is a worse probe than the
 * accessor. The floor is a repo-wide `engines` decision, not this module's.
 */
export function workerThreadsAvailable(): boolean {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    return proc?.getBuiltinModule?.("node:worker_threads") !== undefined;
  } catch {
    return false;
  }
}

/** A bare import, made from wherever THIS FILE physically is.
 *
 *  @internal Exported only so the copy of this module on disk can be called by a
 *  bundled copy of it — see importShellLibrary, which is the one to call. */
export const importFromHere = async (specifier: string): Promise<unknown> =>
  await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ specifier);

/**
 * Load one of the shell's own libraries — just-bash and the three parser
 * libraries — through the copy of this module that is really on disk.
 *
 * These imports have to stay bundler-blind: just-bash's graph reaches
 * `node:worker_threads`, `undici` and `sql.js`, and it `import()`s the two
 * native packages it declares as `optionalDependencies` (`@mongodb-js/zstd`,
 * `node-liblzma`) — installed on a consumer's disk, which is why their build
 * scripts have to be denied (pnpm-workspace.yaml), and unbundleable, so esbuild
 * hard-fails a Worker build on those two: Leg A of
 * `scripts/portability-gate.mjs`. Same containment, and the same reasoning, as
 * the optional e2b SDK (`packages/apps/src/server/escalation/e2b/index.ts`).
 *
 * But bundler-blind means the bundler emits a bare `import("just-bash")` into a
 * chunk that sits in the HOST APP's directory, and Node resolves a bare
 * specifier relative to the importing FILE. All four are dependencies of
 * @vendoai/harnesses alone, so pnpm keeps them in THIS package's node_modules,
 * invisible from there: every shell call answered ERR_MODULE_NOT_FOUND in a real
 * app while the tests, which import from inside this package, stayed green.
 *
 * So hop home first. Bundlers rewrite `import.meta.url` to the ORIGINAL
 * module's path (Turbopack's ImportMetaBinding, webpack's module resource), so
 * importing it loads this file from where it actually lives — beside its own
 * node_modules, in this monorepo and in a consumer's install alike — and the
 * bare import above then resolves the way it always meant to. Unbundled, the hop
 * lands on this very module and costs a cache hit.
 *
 * The hop, not a resolved absolute path: `createRequire(import.meta.url).resolve`
 * answers with the package's CJS entry, and just-bash's CJS bundle has no
 * `import.meta.url` to bootstrap its QuickJS worker from, so `js-exec` dies
 * there with "Invalid URL" while every other command looks fine.
 *
 * Where the recorded URL is not loadable at all (an esbuild/Worker bundle, whose
 * `import.meta.url` is the bundle itself) the bare specifier is all there is.
 */
export async function importShellLibrary<T>(specifier: string): Promise<T> {
  const onDisk = await import(
    /* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */
    import.meta.url
  ).catch(() => ({})) as { importFromHere?: typeof importFromHere };
  return await (onDisk.importFromHere ?? importFromHere)(specifier) as T;
}
