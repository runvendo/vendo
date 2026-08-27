import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { runsAgentLoop } from "@vendoai/actions/sync";
import { exists, stripBom } from "./shared.js";
import { walk } from "./theme/walk.js";

export type HostFramework = "next" | "express" | "unknown";

export interface VendoWiring {
  server: boolean;
  client: boolean;
  /** A VISIBLE agent surface is mounted — <VendoProvider> alone is a context
      provider that renders nothing (0.4.1 E2E cert B3: by-the-book installs
      ended doctor-green with nothing on screen). */
  surface: boolean;
  /** The host still uses the removed <VendoRoot> — doctor prints the swap. The
      NAME alone is not evidence: a host's own wrapper component may be called
      VendoRoot (Maple's is), so this is the import from @vendoai, or the tag
      with no <VendoProvider> anywhere in the source. */
  legacyRoot: boolean;
}

/** What counts as a visible surface: the shipped chrome (<VendoOverlay> and
    the pieces it is built from), the BYO embeds a host chat renders, and the
    hooks a host uses to drive a custom surface. Deliberately generous — this
    list gates a doctor FAILURE, so a host with any plausible surface of its
    own must pass. */
export const SURFACE_MARKERS: readonly string[] = [
  "<VendoOverlay",
  "<VendoThread",
  "<VendoTrigger",
  "<VendoPalette",
  "<VendoSlot",
  "<VendoAppEmbed",
  "<VendoApprovalEmbed",
  "<VendoToolResult",
  "useVendoOverlay(",
  "useVendoThread(",
  "useSlotApp(",
];

/** A `VendoRoot` named in an import from a Vendo package — the removed export
    taken from the package, the one spelling that can no longer resolve. Both
    the scoped packages and the unscoped `vendoai` alias count: the alias
    re-exported VendoRoot too while it existed. (Specifiers are not spelled out
    in prose here: the dependency guard reads a literal one as a real
    cross-package import.) */
const LEGACY_ROOT_IMPORT = /import\s*\{[^}]*\bVendoRoot\b[^}]*\}\s*from\s*["'](?:@vendoai\/|vendoai["'/])/;

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SOURCE_SCAN_MAX_FILES = 2_000;

export async function detectFramework(root: string): Promise<HostFramework> {
  try {
    const manifest = JSON.parse(stripBom(await readFile(join(root, "package.json"), "utf8"))) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const sections = [manifest.dependencies, manifest.devDependencies];
    if (sections.some((dependencies) => dependencies?.next !== undefined)) return "next";
    if (sections.some((dependencies) => dependencies?.express !== undefined)) return "express";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** What Next must leave OUT of the server bundle. `@vendoai/apps` is the entry
    that fixes the bug, and listing `esbuild` alone does NOT: the apps checker
    imports it through a VARIABLE specifier behind bundler-ignore comments (apps
    src/server/checking/toolchain.ts), so there is no static "esbuild" request
    for Next to match against the list. Bundle @vendoai/apps and that import
    becomes a bare runtime resolve from the app root, where pnpm never hoists
    esbuild — every generated screen then fails its checks while the app looks
    fine. Externalizing the PACKAGE keeps the import inside it, where esbuild is
    a declared dependency. PGlite's Emscripten module and the store that loads it
    stay external for their own reason: they break under production chunking. */
export const NEXT_SERVER_EXTERNALS: readonly string[] = ["@vendoai/apps", "esbuild", "@electric-sql/pglite", "@vendoai/store"];

/** The property exactly as init writes it and doctor tells you to paste it. */
export const NEXT_SERVER_EXTERNALS_LINE =
  `serverExternalPackages: [${NEXT_SERVER_EXTERNALS.map((name) => JSON.stringify(name)).join(", ")}],`;

/** The list, under either spelling: Next 15's `serverExternalPackages` and Next
    14's `experimental.serverComponentsExternalPackages` (renamed, same wiring).
    Group 1 is everything through the `[`, group 2 the names already listed. */
export const SERVER_EXTERNALS_ARRAY = /(server(?:Components)?ExternalPackages\s*:\s*\[)([^\]]*)/;

/** The host's next.config, whichever extension it uses; null when it has none. */
export async function nextConfigPath(root: string): Promise<string | null> {
  for (const file of ["next.config.ts", "next.config.js", "next.config.mjs"]) {
    if (await exists(join(root, file))) return join(root, file);
  }
  return null;
}

/** The source with every comment BLANKED to spaces rather than removed, so it
    stays the same LENGTH and an index into it is an index into the original.
    A commented-out `serverExternalPackages` line is exactly what a host
    debugging its bundle leaves behind, and reading one as configuration greened
    E-CFG-004 on a host that was still broken. Deliberately not a parser: it
    blanks a `//` inside a string literal too, and the cost of that is a printed
    paste instead of an edit — never a wrong edit. */
export function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

const TRANSPILE_ARRAY = /transpilePackages\s*:\s*\[([^\]]*)/;

const listsName = (list: string, name: string): boolean =>
  list.includes(`"${name}"`) || list.includes(`'${name}'`);

/** Which externals a next.config's TEXT does not already carry. */
export function missingServerExternals(source: string): string[] {
  const listed = SERVER_EXTERNALS_ARRAY.exec(blankComments(source))?.[2] ?? "";
  return NEXT_SERVER_EXTERNALS.filter((name) => !listsName(listed, name));
}

/** Which of those the host TRANSPILES — the one state where the property must
    not be written for them. Next REFUSES a package named in both lists and
    hard-fatals at boot, so a source-linked host (our own demo-bank was one)
    that follows the advice unedited loses its dev server. */
export function transpiledServerExternals(source: string): string[] {
  const listed = TRANSPILE_ARRAY.exec(blankComments(source))?.[1] ?? "";
  return NEXT_SERVER_EXTERNALS.filter((name) => listsName(listed, name));
}

/** The extra sentence init's paste and doctor's finding both carry in that
    state: the fix is two steps, and doing only the second one bricks the host. */
export const transpileConflictNote = (conflicting: readonly string[]): string =>
  `Remove ${conflicting.join(", ")} from transpilePackages first — Next refuses a package named in both lists and hard-fatals at boot.`;

/** The workspace packages that look like the real host, for an init run one
    level too high: a monorepo root declares neither next nor express, so
    detection lands on the runtime-neutral custom scaffold and the dev never
    notices. Deliberately just the two conventional workspace dirs — a hint
    that names a candidate, not a workspace-glob resolver. Paths are relative
    and posix-style (they go straight into a `vendo init <dir>` suggestion). */
export async function workspaceHostCandidates(root: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const group of ["apps", "packages"]) {
    const entries = await readdir(join(root, group), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await detectFramework(join(root, group, entry.name)) !== "unknown") candidates.push(`${group}/${entry.name}`);
    }
  }
  return candidates;
}

/** Both supported spellings of the Supabase preset specifier — the scoped
    umbrella and the unscoped `vendoai` alias re-export ("both names ship the
    same wire"; greptile on #1374: an alias-wired host missed E-AUTH-009
    entirely). A regex, not string literals, so the dependency guard never
    reads an import-shaped alias specifier here (same reason as
    LEGACY_ROOT_IMPORT above). */
export const SUPABASE_PRESET_IMPORT = /["'](?:@vendoai\/vendo|vendoai)\/auth\/supabase["']/;

/** The clerk preset's specifier, both spellings — same shape, same reasons
    (#1338 rides the same table E-AUTH-009 does). */
export const CLERK_PRESET_IMPORT = /["'](?:@vendoai\/vendo|vendoai)\/auth\/clerk["']/;

/** Both supported spellings of the server entry, for the same reason: an
    alias-wired host (`createVendo` imported from the unscoped package's
    /server) is WIRED, and reading it as bare misdiagnosed it E-WIRE-001/007. */
const SERVER_ENTRY_IMPORT = /["'](?:@vendoai\/vendo|vendoai)\/server["']/;

/** Whether any host source matches `marker`, comments stripped, over the SAME
    bounded walk `detectVendoWiring` takes — so a host too big to scan is judged
    consistently whichever marker asked. */
async function hostSourceMatches(root: string, marker: RegExp): Promise<boolean> {
  const files = await walk(root, (relativePath) => SOURCE_FILE.test(relativePath), SOURCE_SCAN_MAX_FILES);
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (marker.test(code)) return true;
  }
  return false;
}

/** Whether any host source imports the Supabase auth preset. Import marker
    only: outside a known Vendo composition file a bare `supabase(` call is the
    host's OWN Supabase client, not the preset (expense.fyi defines exactly such
    a helper). */
export async function wiresSupabaseAuth(root: string): Promise<boolean> {
  return hostSourceMatches(root, SUPABASE_PRESET_IMPORT);
}

export async function wiresClerkAuth(root: string): Promise<boolean> {
  return hostSourceMatches(root, CLERK_PRESET_IMPORT);
}

/** Whether any host source reaches the tenant-connector API. A property read on
    the Vendo handle is unambiguous evidence — the name exists nowhere else — so
    unlike the Supabase marker this needs no composition-file narrowing. */
export async function wiresTenantConnectors(root: string): Promise<boolean> {
  return hostSourceMatches(root, /\.tenantConnectors\b/);
}

/** Whether the host's guard is wired to read its rules from a FILE. The empty
    policy object is that and nothing else — it is what `vendo init` writes
    (cli/init-scaffolds.ts) and the one spelling whose only meaning is "the
    rules live at the default path". Inline rules, a preset name and an
    explicitly named `file` all say something different and are deliberately
    not matched: the first two replace the file, the third fails loud on its
    own (guard/src/policy.ts:115). */
export async function wiresPolicyFile(root: string): Promise<boolean> {
  return hostSourceMatches(root, /\bpolicy\s*:\s*\{\s*\}/);
}

/** Whether the host builds its OWN store. Load-bearing for anything that reads
    a key as evidence of a Cloud seam: an explicitly passed store always wins
    over VENDO_API_KEY (the adapter rule, compose-store.ts's `selectStore`), so
    a host that calls this has a local store no matter what its environment
    says. */
export async function composesOwnStore(root: string): Promise<boolean> {
  return hostSourceMatches(root, /\bcreateStore\s*\(/);
}

/** An API route file: an app-router `route.*` under an `api` segment, or
    anything under `pages/api`. The agent-loop probe below is deliberately
    narrower than the whole source tree — a lib module that happens to call
    `generateText` is not a loop the host serves. */
const API_ROUTE_FILE = /(?:^|\/)api\/(?:.*\/)?route\.[cm]?[jt]sx?$|(?:^|\/)pages\/api\//;

/** The host's own agent-loop route, as a posix-style root-relative directory
 *  (`app/api/chat`), or null.
 *
 *  This is what makes "through your own agent loop" the RECOMMENDED use case for
 *  a host that already has one, instead of a third option nobody reads. The
 *  evidence is the route scanner's own marker (`runsAgentLoop`), which is also
 *  what excludes that route from the callable catalog — so the recommendation
 *  and the exclusion can never disagree about what a loop is.
 *
 *  Not `hostSourceMatches`: that one walks every source file and answers a
 *  boolean, and this needs both the narrower route filter and the PATH — the
 *  route's directory is what the recommendation shows the developer.
 *
 *  Same bounded walk and comment-stripping as `detectVendoWiring`, so a host too
 *  big to scan is judged consistently. First match wins: one loop is the whole
 *  answer, and the directory is what a human recognises. */
export async function detectAgentLoopRoute(root: string): Promise<string | null> {
  const files = await walk(
    root,
    (relativePath) => SOURCE_FILE.test(relativePath) && API_ROUTE_FILE.test(relativePath.split(sep).join("/")),
    SOURCE_SCAN_MAX_FILES,
  );
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (runsAgentLoop(code)) {
      const parts = relative(root, file).split(sep);
      return parts.slice(0, -1).join("/");
    }
  }
  return null;
}

/** Bounded source scan shared by init and doctor so their wiring verdicts
    agree. */
export async function detectVendoWiring(root: string): Promise<VendoWiring> {
  let server = false;
  let provider = false;
  let legacyTag = false;
  let legacyImport = false;
  let surface = false;
  const files = await walk(root, (relativePath) => SOURCE_FILE.test(relativePath), SOURCE_SCAN_MAX_FILES);
  for (const file of files) {
    const source = await readFile(file, "utf8").catch(() => "");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    if (SERVER_ENTRY_IMPORT.test(code) && /\bcreateVendo\s*\(/.test(code)) server = true;
    if (code.includes("<VendoProvider")) provider = true;
    if (code.includes("<VendoRoot")) legacyTag = true;
    if (LEGACY_ROOT_IMPORT.test(code)) legacyImport = true;
    if (SURFACE_MARKERS.some((marker) => code.includes(marker))) surface = true;
    if (server && provider && surface) break;
  }
  return {
    server,
    client: provider || legacyTag,
    surface,
    legacyRoot: legacyImport || (legacyTag && !provider),
  };
}
