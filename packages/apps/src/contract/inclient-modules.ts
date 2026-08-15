/** The complete allowlist of module specifiers in-client code may import.
 *  The mount table in `@vendoai/ui` (`tree/host-mount.tsx`) is typed
 *  `Record<InClientModule | InClientBundledPackage, unknown>`, so a drift is a
 *  compile error. */
export const IN_CLIENT_ALLOWED_MODULES = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
] as const;

/** A module specifier in-client code can resolve. */
export type InClientModule = (typeof IN_CLIENT_ALLOWED_MODULES)[number];

/**
 * Third-party packages the in-client mount table answers for real, so a
 * captured host component that imports them loads at all.
 *
 * The three here are the ones that block real host components from rendering —
 * every one is tiny, dependency-free, universal in Next hosts, and
 * side-effect-free:
 *   - `clsx` + `tailwind-merge`: the shadcn `lib/cn.ts` default, which almost
 *     every registered component imports transitively.
 *   - `zod`: hosts declare `props:` schemas next to the component, so the
 *     component's own module imports zod (Vendo's documented registry pattern).
 *
 * This list is deliberately hard to grow. A charting or data library is not a
 * candidate: it is large, it is a version-compatibility hazard, and a host
 * importing one still gets an honest "cannot render" instead of a bundle nobody
 * asked for.
 *
 * KNOWN COST: the mount answers with OUR pinned copy, not the host's. A host on
 * a different major can see behaviour that differs from their app.
 */
export const IN_CLIENT_BUNDLED_PACKAGES = [
  "clsx",
  "tailwind-merge",
  "zod",
] as const;

/** A third-party package the in-client mount table bundles. */
export type InClientBundledPackage = (typeof IN_CLIENT_BUNDLED_PACKAGES)[number];

/** `<name>@<exact version>` plus an optional subpath — never a range, never a
 *  tag. `vendo sync` writes the version the host actually has installed; a
 *  version it cannot resolve exactly is an honest skip, not a guess. */
// The per-segment lookahead is load-bearing: `[\w.-]+` alone admits `..`, so a
// pin could walk out of the package (`recharts@3.9.2/../../etc/passwd`).
const PINNED_PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d[\w.+-]*(?:\/(?!\.\.?(?:\/|$))[\w.-]+)*$/u;

export const isPinnedPackage = (pin: string): boolean => PINNED_PACKAGE.test(pin);
