/** The complete allowlist of module specifiers generated <Island> code may
 *  import. This is the SINGLE SOURCE OF TRUTH shared by two enforcers:
 *  - the jail runtime (`packages/ui/src/tree/jail/runtime-entry.tsx`), whose
 *    `JAIL_MODULES` require-table is typed `Record<JailModule, unknown>` so a
 *    drift is a compile error; and
 *  - the generation engine (`packages/apps/src/engine.ts`), which rejects any
 *    island importing a specifier outside this set at create/edit → repair.
 *
 *  Islands render inside an opaque-origin, network-denied jail: only React and
 *  ReactDOM are reachable. An external chart/util import cannot load, so the
 *  engine must catch it before it ships (verify-v2 #5: a `recharts` island
 *  error-boxed the whole app). */
export const JAIL_ALLOWED_MODULES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
] as const;

/** A module specifier the Vendo jail can resolve. */
export type JailModule = (typeof JAIL_ALLOWED_MODULES)[number];
