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
 */
export function workerThreadsAvailable(): boolean {
  try {
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    return proc?.getBuiltinModule?.("node:worker_threads") !== undefined;
  } catch {
    return false;
  }
}
