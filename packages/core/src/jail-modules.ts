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

/**
 * Third-party packages BUNDLED into the jail runtime, so code inside the jail
 * can `import` them for real.
 *
 * Kept separate from `ISLAND_STRIPPED_SPECIFIERS` because the two lists mean
 * different things and one list cannot serve both: a STRIPPED specifier has its
 * import statement deleted because the ambient scope already provides the name;
 * a BUNDLED package must keep its import statement so its compiled module
 * request for "clsx" reaches the jail's module table. Stripping one of these
 * would delete the binding and leave a ReferenceError.
 *
 * The three here are the ones that block real host components from previewing at
 * all — every one is tiny, dependency-free, universal in Next hosts, and
 * side-effect-free:
 *   - `clsx` + `tailwind-merge`: the shadcn `lib/cn.ts` default, which almost
 *     every registered component imports transitively.
 *   - `zod`: hosts declare `props:` schemas next to the component, so the
 *     component's own module imports zod (Vendo's documented registry pattern).
 *
 * This list is deliberately hard to grow. A charting or data library is not a
 * candidate: it is large, it is a version-compatibility hazard, and a host
 * importing one still gets an honest "cannot preview" instead of a bundle nobody
 * asked for.
 *
 * KNOWN COST: the jail ships OUR pinned copy, not the host's. A host on a
 * different major can see preview behaviour that differs from their app.
 */
export const JAIL_BUNDLED_PACKAGES = [
  "clsx",
  "tailwind-merge",
  "zod",
] as const;

/** A third-party package the jail runtime bundles. */
export type JailBundledPackage = (typeof JAIL_BUNDLED_PACKAGES)[number];
