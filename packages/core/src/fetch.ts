/** The safe default for every `options.fetch ?? …` seam. A bare
 *  `globalThis.fetch` stored in a variable and invoked later arrives with the
 *  wrong receiver, which strict Web runtimes (Cloudflare Workers, browsers)
 *  reject as "Illegal invocation"; the wrapper late-binds through globalThis
 *  on every call, so it also tracks fetch replacements (polyfills, test
 *  mocks) installed after capture. */
export const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

/** Discovery discipline (spec 2026-07-25): an opt-in per-round-trip log line at the
 *  connector transport seams (`VENDO_DEBUG_CONNECTOR_HTTP=1`), so a live turn's
 *  connector HTTP round-trips can be counted from server output — the seam the
 *  ≤6-round-trips proof reads. The flag is captured ONCE at module load (an
 *  operator boot decision, like NODE_ENV): adapters keep the adapter-rule
 *  invariant of never reading the environment per call, and Worker targets
 *  (no `process`) stay clean via the guarded globalThis read. */
const DEBUG_CONNECTOR_HTTP =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VENDO_DEBUG_CONNECTOR_HTTP === "1";

export function debugConnectorHttp(connector: string, method: string, path: string): void {
  if (!DEBUG_CONNECTOR_HTTP) return;
  console.info(`[vendo:connector-http] ${connector} ${method} ${path}`);
}
