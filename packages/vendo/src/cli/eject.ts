/**
 * `vendo eject <surface>` — copy a shipped chrome surface's presentation
 * source out of the installed @vendoai/ui into the host repo as code the
 * developer owns, shadcn-style (§4 customization ladder, eject rung).
 *
 * Pixels are copied; data/wire logic stays a package dependency: the
 * templates' package-internal relative imports are rewritten to the public
 * @vendoai/ui subpaths, so protocol updates keep flowing to ejected code.
 * A `.vendo-eject.json` manifest in the ejected directory records surface +
 * package version for doctor's drift check.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, posix, relative } from "node:path";
import { consoleOutput, exists, withCommandRun, type Output, type TelemetryOptions } from "./shared.js";

export interface EjectOptions {
  targetDir: string;
  surface?: string;
  list?: boolean;
  force?: boolean;
  output?: Output;
  /** Injectable telemetry deps (matches init/doctor). */
  telemetry?: TelemetryOptions;
}

interface TemplatesManifest {
  version: string;
  surfaces: Record<string, {
    description: string;
    /** Exported component the swap instruction names. */
    component: string;
    /** src/-relative dir the surface's relative imports resolve against. */
    sourceBase: string;
    /** Set when the surface owns a directory: imports into it stay relative. */
    sourceDir?: string;
    files: string[];
  }>;
}

export const EJECT_MANIFEST_FILE = ".vendo-eject.json";

export interface EjectedManifest {
  surface: string;
  package: "@vendoai/ui";
  version: string;
}

/** dist/eject-templates of the installed @vendoai/ui — host install first
    (its version is what the host runs), the CLI's own copy as fallback for
    strict layouts where the host doesn't depend on @vendoai/ui directly. */
function templatesRoot(targetDir: string): string | null {
  const anchors = [join(targetDir, "package.json"), import.meta.url];
  for (const anchor of anchors) {
    try {
      const entry = createRequire(anchor).resolve("@vendoai/ui");
      return join(dirname(entry), "eject-templates");
    } catch {
      // try the next anchor
    }
  }
  return null;
}

/**
 * Rewrite one template source for life in the host repo. Relative specifiers
 * resolve against the surface's src/-relative sourceBase: imports landing in
 * the surface's own directory stay relative (dropping the .js extension for
 * host bundlers), everything else maps to the public package subpath it is
 * exported from (tree/ → @vendoai/ui/tree, chrome/ → @vendoai/ui/chrome,
 * hooks/context/theme → @vendoai/ui).
 */
export function rewriteTemplateSource(
  source: string,
  shape: { sourceBase: string; sourceDir?: string },
): string {
  // from-clauses, side-effect imports, and dynamic import() all carry
  // specifiers; the quote never follows "import" directly in a from-clause,
  // so the alternation cannot double-match.
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\2/g,
    (whole, lead: string, quote: string, specifier: string) => {
      if (!specifier.startsWith(".")) return whole;
      const resolved = posix.normalize(posix.join(shape.sourceBase, specifier)).replace(/\.js$/, "");
      let rewritten: string;
      if (
        shape.sourceDir !== undefined &&
        (resolved === shape.sourceDir || resolved.startsWith(`${shape.sourceDir}/`))
      ) {
        rewritten = specifier.replace(/\.js$/, "");
      } else if (resolved.startsWith("tree/")) rewritten = "@vendoai/ui/tree";
      else if (resolved.startsWith("chrome/")) rewritten = "@vendoai/ui/chrome";
      else rewritten = "@vendoai/ui";
      return `${lead}${quote}${rewritten}${quote}`;
    },
  );
}

/** components/vendo/<surface>, under src/ when the host keeps its app there
    (same layout probe as init's appDirectory). `srcLayout` also picks the
    swap hint's import form: src hosts import via their @/ alias. */
async function destinationDir(
  root: string,
  surface: string,
): Promise<{ destination: string; srcLayout: boolean }> {
  const srcLayout = await exists(join(root, "src", "app"));
  const base = srcLayout ? join(root, "src") : root;
  return { destination: join(base, "components", "vendo", surface), srcLayout };
}

export async function runEject(options: EjectOptions): Promise<number> {
  const output = options.output ?? consoleOutput;
  const root = options.targetDir;
  return withCommandRun(
    {
      command: "eject",
      root,
      ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
    },
    (failure) => eject(options, output, root, failure),
  );
}

async function eject(
  options: EjectOptions,
  output: Output,
  root: string,
  failure: { failedStep?: string },
): Promise<number> {
  const templates = templatesRoot(root);
  if (templates === null || !(await exists(join(templates, "templates.json")))) {
    failure.failedStep = "templates";
    output.error(
      "vendo eject: could not find an installed @vendoai/ui with eject templates — install vendoai (or @vendoai/ui) first.",
    );
    return 1;
  }
  const manifest = JSON.parse(await readFile(join(templates, "templates.json"), "utf8")) as TemplatesManifest;
  const available = Object.keys(manifest.surfaces).sort();

  if (options.list === true) {
    output.log(`Ejectable surfaces (@vendoai/ui v${manifest.version}):`);
    for (const surface of available) {
      output.log(`  ${surface}  ${manifest.surfaces[surface]!.description}`);
    }
    output.log("\nRun `vendo eject <surface>` to copy one into your repo.");
    return 0;
  }

  const surface = options.surface;
  if (surface === undefined || surface === "") {
    failure.failedStep = "surface";
    output.error(`vendo eject: name a surface (${available.join(", ")}) or use --list.`);
    return 1;
  }
  const entry = manifest.surfaces[surface];
  if (entry === undefined) {
    failure.failedStep = "surface";
    output.error(`vendo eject: unknown surface "${surface}" — available: ${available.join(", ")}.`);
    return 1;
  }

  const { destination, srcLayout } = await destinationDir(root, surface);
  if (await exists(destination)) {
    if (options.force !== true) {
      failure.failedStep = "exists";
      output.error(
        `vendo eject: ${relative(root, destination)} already exists — it may hold your edits. Re-run with --force to overwrite.`,
      );
      return 1;
    }
    await rm(destination, { recursive: true, force: true });
  }

  await mkdir(destination, { recursive: true });
  const shape = { sourceBase: entry.sourceBase, ...(entry.sourceDir === undefined ? {} : { sourceDir: entry.sourceDir }) };
  for (const file of entry.files) {
    const source = await readFile(join(templates, surface, file), "utf8");
    await writeFile(join(destination, file), rewriteTemplateSource(source, shape), "utf8");
  }
  const ejected: EjectedManifest = { surface, package: "@vendoai/ui", version: manifest.version };
  await writeFile(join(destination, EJECT_MANIFEST_FILE), `${JSON.stringify(ejected, null, 2)}\n`, "utf8");

  const relDir = relative(root, destination);
  const componentName = entry.component;
  // src hosts import through their @/ alias; "./src/…" would mislead (Devin
  // ANALYSIS_0001 — an importer under src/ never writes the src/ segment).
  const importHint = srcLayout ? `@/components/vendo/${surface}` : `./components/vendo/${surface}`;
  output.log(`Ejected ${surface} → ${relDir} (${entry.files.length} files, @vendoai/ui v${manifest.version})`);
  output.log("");
  output.log("Swap it in:");
  output.log(`  import { ${componentName} } from "${importHint}";`);
  output.log(surface === "thread"
    ? `  <VendoOverlay thread={${componentName}} />`
    : `  <${componentName} />  (in place of the @vendoai/ui/chrome import)`);
  output.log("");
  output.log("The files are yours to edit. Data and wire logic still flow from @vendoai/ui.");
  return 0;
}
