/**
 * Eject-template assembly (§4 customization ladder, eject rung).
 *
 * Ships the chrome presentation source for ejectable surfaces inside the
 * published package: verbatim .tsx/.ts files under dist/eject-templates/
 * plus a templates.json manifest the CLI reads. Assembly enforces the eject
 * contract at build time: a template may import only
 *   - its own surface directory (thread's "./…" siblings),
 *   - bare package specifiers (react, ai, @vendoai/core), or
 *   - package internals whose every imported name is publicly exported from
 *     @vendoai/ui, @vendoai/ui/chrome, or @vendoai/ui/tree — because the CLI
 *     rewrites those relative imports to the public subpaths on eject.
 *
 * Each surface records `sourceBase` — the src/ directory its relative imports
 * resolve against — so a single-file surface living in chrome/ itself
 * (activities) classifies "./sibling.js" as a chrome-internal import while
 * the thread directory keeps "./composer.js" intra-surface.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import ts from "typescript";

export const SURFACES = {
  thread: {
    description: "The conversation thread: composer, message list, parts, scrolling.",
    component: "VendoThread",
    sourceBase: "chrome/thread",
    // Has its own directory — sibling imports stay relative in the ejected copy.
    sourceDir: "chrome/thread",
  },
  activities: {
    description: "The placeable activity piece: approvals queue + recent-runs feed.",
    component: "VendoActivities",
    sourceBase: "chrome",
    // Single file, shipped as the surface's index.tsx.
    files: { "index.tsx": "src/chrome/vendo-activities.tsx" },
  },
};

/** Public entry sources, keyed by the surface group the checker maps to. */
const PUBLIC_ENTRIES = {
  root: "src/index.ts",
  chrome: "src/chrome/index.ts",
  tree: "src/tree/index.ts",
};

const TEMPLATE_FILE = /\.(?:ts|tsx)$/;

function parse(fileName, source) {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
}

async function resolveModuleFile(fromFile, specifier) {
  const base = join(dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // try the next extension
    }
  }
  return null;
}

/** Syntactic export-name extraction, following `export * from` re-exports. */
async function exportedNames(file, seen = new Set()) {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const names = new Set();
  const sourceFile = parse(file, await readFile(file, "utf8"));
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      } else if (statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = await resolveModuleFile(file, statement.moduleSpecifier.text);
        if (target !== null) for (const name of await exportedNames(target, seen)) names.add(name);
      }
      continue;
    }
    const hasExport = ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (hasExport !== true) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    } else if (statement.name !== undefined && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/** Export-name sets of the three public surfaces: { root, chrome, tree }. */
export async function publicSurfaces(packageDir) {
  const surfaces = {};
  for (const [key, entry] of Object.entries(PUBLIC_ENTRIES)) {
    surfaces[key] = await exportedNames(join(packageDir, entry));
  }
  return surfaces;
}

/**
 * Which public surface a template's relative import must resolve from, given
 * the surface's src/-relative sourceBase. Returns null for intra-surface
 * imports (they stay relative in the ejected copy).
 */
export function classifySpecifier(specifier, { sourceBase, sourceDir }) {
  const resolved = posix.normalize(posix.join(sourceBase, specifier)).replace(/\.js$/, "");
  if (sourceDir !== undefined && (resolved === sourceDir || resolved.startsWith(`${sourceDir}/`))) {
    return null;
  }
  if (resolved.startsWith("tree/")) return "tree";
  if (resolved.startsWith("chrome/")) return "chrome";
  return "root";
}

/**
 * Returns human-readable errors for every import in `source` that escapes the
 * surface but names a symbol the public surfaces don't export.
 */
export function checkTemplateSource(relPath, source, surfaces, shape) {
  const errors = [];
  const sourceFile = parse(relPath, source);
  // Side-effect and dynamic imports carry no named bindings, so an escaping
  // one can be neither verified against public exports nor rewritten to a
  // meaningful subpath import — reject them at build (Devin ANALYSIS_0004).
  for (const match of source.matchAll(/\bimport\s*\(\s*["'](\.[^"']*)["']/g)) {
    if (classifySpecifier(match[1], shape) !== null) {
      errors.push(
        `${relPath}: dynamic import("${match[1]}") escapes the surface and cannot be rewritten — import the module statically or keep it inside the surface`,
      );
    }
  }
  for (const statement of sourceFile.statements) {
    let specifier;
    const imported = [];
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      specifier = statement.moduleSpecifier.text;
      if (statement.importClause === undefined) {
        if (specifier.startsWith(".") && classifySpecifier(specifier, shape) !== null) {
          errors.push(
            `${relPath}: side-effect import "${specifier}" escapes the surface and cannot be rewritten — keep it inside the surface or drop it`,
          );
        }
        continue;
      }
      const clause = statement.importClause;
      if (clause?.name !== undefined) imported.push("default");
      if (clause?.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) imported.push("*");
        else for (const element of clause.namedBindings.elements) {
          imported.push((element.propertyName ?? element.name).text);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifier = statement.moduleSpecifier.text;
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          imported.push((element.propertyName ?? element.name).text);
        }
      } else imported.push("*");
    } else {
      continue;
    }
    if (!specifier.startsWith(".")) continue; // bare package specifier — host dependency
    const surface = classifySpecifier(specifier, shape);
    if (surface === null) continue; // intra-surface relative import stays relative on eject
    for (const name of imported) {
      if (name === "*" || name === "default") {
        errors.push(
          `${relPath}: ${name === "*" ? "namespace" : "default"} import from "${specifier}" cannot be verified against @vendoai/ui public exports — import named symbols instead`,
        );
      } else if (!surfaces[surface].has(name)) {
        errors.push(
          `${relPath}: "${name}" (from "${specifier}") is not exported from the public ${surface === "root" ? "@vendoai/ui" : `@vendoai/ui/${surface}`} surface — export it deliberately or drop the import`,
        );
      }
    }
  }
  return errors;
}

function header(version) {
  return [
    "/**",
    ` * Ejected from @vendoai/ui v${version} — yours to edit.`,
    " * Presentation only: data and wire logic still flow through @vendoai/ui",
    " * imports, so protocol updates keep working while these pixels are yours.",
    " */",
    "",
  ].join("\n");
}

/** [templateFileName, absoluteSourcePath] pairs for one surface. */
async function surfaceFiles(packageDir, surface) {
  if (surface.sourceDir !== undefined) {
    const dir = join(packageDir, "src", surface.sourceDir);
    const names = (await readdir(dir)).filter((name) => TEMPLATE_FILE.test(name)).sort();
    return names.map((name) => [name, join(dir, name)]);
  }
  return Object.entries(surface.files).map(([name, source]) => [name, join(packageDir, source)]);
}

/**
 * Assembles dist/eject-templates/<surface>/ + templates.json. Throws when any
 * template imports package internals that are not publicly exported.
 */
export async function assembleEjectTemplates(packageDir) {
  const version = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")).version;
  const surfaces = await publicSurfaces(packageDir);
  const outRoot = join(packageDir, "dist", "eject-templates");
  const manifest = { version, surfaces: {} };
  const errors = [];
  const outputs = [];

  for (const [name, surface] of Object.entries(SURFACES)) {
    const files = await surfaceFiles(packageDir, surface);
    const shape = { sourceBase: surface.sourceBase, sourceDir: surface.sourceDir };
    for (const [file, sourcePath] of files) {
      const source = await readFile(sourcePath, "utf8");
      errors.push(...checkTemplateSource(`${name}/${file}`, source, surfaces, shape));
      outputs.push({ path: join(outRoot, name, file), content: header(version) + source });
    }
    manifest.surfaces[name] = {
      description: surface.description,
      component: surface.component,
      sourceBase: surface.sourceBase,
      ...(surface.sourceDir === undefined ? {} : { sourceDir: surface.sourceDir }),
      files: files.map(([file]) => file),
    };
  }

  if (errors.length > 0) {
    throw new Error(`eject templates are not standalone against public exports:\n${errors.join("\n")}`);
  }

  await rm(outRoot, { recursive: true, force: true });
  for (const output of outputs) {
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, output.content, "utf8");
  }
  await writeFile(join(outRoot, "templates.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}
