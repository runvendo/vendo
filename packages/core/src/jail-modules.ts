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

/**
 * The ONE origin the jail may load npm packages from, and PREVIEW VENUE ONLY.
 *
 * The jail is also the production render path for a remix fork inside a
 * customer's own page. CDN loading must never reach there: a customer's end
 * users would depend on a third party's uptime, and that third party would see
 * their traffic. The gate is `JailFurnishing.packages`, which only a preview
 * surface sets and which `stripServerAuthoritativeFields` deletes off any
 * stored or imported tree — with no packages the jail's CSP names no origin at
 * all, so the production policy is byte-identical to the network-denied one.
 *
 * esm.sh, pinned here and nowhere else. Browser-verified against the real jail
 * (two nested opaque-origin frames, `default-src 'none'`): every request in a
 * `recharts` module graph stays on this one origin, so ONE `script-src` source
 * is enough; `?external=react,react-dom` makes the package import bare `react`,
 * which the jail answers with its OWN React through an import map — the
 * alternative (a second React copy from the CDN) is a null-dispatcher crash,
 * measured, not assumed.
 */
export const JAIL_PACKAGE_CDN_ORIGIN = "https://esm.sh";

/** `<name>@<exact version>` plus an optional subpath — never a range, never a
 *  tag. `vendo sync` writes the version the host actually has installed; a
 *  version it cannot resolve exactly is an honest skip, not a guess, so this
 *  pattern is also the runtime's refusal to build a URL from anything looser. */
// The per-segment lookahead is load-bearing: `[\w.-]+` alone admits `..`, so a
// pin could walk out of the package (`recharts@3.9.2/../../etc/passwd`).
const PINNED_JAIL_PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d[\w.+-]*(?:\/(?!\.\.?(?:\/|$))[\w.-]+)*$/u;

export const isPinnedJailPackage = (pin: string): boolean => PINNED_JAIL_PACKAGE.test(pin);

/**
 * The module URL for one pinned package, or null when the pin is not an exact
 * `name@version[/subpath]` (a floating range must never reach the network).
 *
 * Every query parameter is load-bearing, each verified in a browser:
 *  - `external=react,react-dom` keeps the jail's own React the only React in
 *    the realm, and esm.sh propagates it through transitive dependencies (so a
 *    dep cannot drag in a second copy).
 *  - `standalone` collapses the dependency graph into one module: `recharts`
 *    costs 113 requests without it and 8 with it, and a gallery mounts several
 *    jails at once.
 *  - `target` is explicit because esm.sh otherwise answers `Vary: User-Agent`,
 *    which makes the bytes a preview gets depend on the browser string.
 *
 * KNOWN LIMIT: the pin freezes the PACKAGE, not its dependency graph. esm.sh
 * resolves the bundled deps when it builds, so a rebuild can move them.
 */
export function jailPackageUrl(pin: string): string | null {
  if (!isPinnedJailPackage(pin)) return null;
  return `${JAIL_PACKAGE_CDN_ORIGIN}/${pin}?target=es2022&external=react,react-dom&standalone`;
}
