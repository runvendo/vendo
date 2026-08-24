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
