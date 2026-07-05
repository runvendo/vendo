/**
 * `vendo sync` environment build: from the captured component sources,
 * produce the vendored dependency graph, import map, sanitized host CSS, and
 * the env manifest, written under `.vendo/env/` and copied to
 * `public/vendo/env/` for the stage's blob pipeline to fetch.
 *
 * Fail-open per item: a dep that will not bundle, or a missing stylesheet, is
 * reported and the anchor keeps whatever it can. The env NEVER fails the host
 * build for a classification gap.
 */
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { EnvManifest, RemixSourceRecord } from "@vendoai/core";
import { classifyImport, importSpecifiers, toManifestStatus } from "./classify.js";
import { readAliases, refusalReason, resolveModuleFile } from "./capture.js";
import { sanitizeCss } from "./host-css.js";

const VENDOR_SOFT_CAP = 2 * 1024 * 1024;

/** Framework/data specifier → @vendoai/sandbox-shims source subpath. Each is
 *  bundled to ESM and mapped so a remixed component's `import ... from "next/link"`
 *  resolves in-sandbox (Codex review: shims were classified but never wired). */
const SHIM_ENTRIES: Record<string, string> = {
  "next/link": "next-link",
  "next/image": "next-image",
  "next/navigation": "next-navigation",
  swr: "swr",
};

export interface BuildEnvResult {
  manifest: EnvManifest;
  report: string[];
}

/** Locate the app's CSS entry (globals.css) for source compilation. */
function findCssEntry(targetDir: string): string | undefined {
  for (const rel of ["src/app/globals.css", "app/globals.css", "src/styles/globals.css", "styles/globals.css"]) {
    const full = path.join(targetDir, rel);
    if (existsSync(full)) return full;
  }
  return undefined;
}

export interface BuildEnvOptions {
  now?: () => string;
  /** Injectable CSS compiler (default: read the entry file raw). Real Tailwind
   *  compilation is wired at the app level; sync ships the raw stylesheet plus
   *  the vendored @tailwindcss/browser JIT that expands utilities at runtime. */
  compileCss?: (entry: string) => string;
}

export async function buildEnvironment(
  targetDir: string,
  records: Record<string, RemixSourceRecord>,
  opts: BuildEnvOptions = {},
): Promise<BuildEnvResult> {
  const report: string[] = [];
  const envDir = path.join(targetDir, ".vendo", "env");
  const publicDir = path.join(targetDir, "public", "vendo", "env");
  const vendorDir = path.join(envDir, "vendor");

  const anchors: EnvManifest["anchors"] = {};
  const npmToVendor = new Map<string, string>(); // specifier → vendor entry file
  const shimsToVendor = new Set<string>(); // shimmed specifiers actually imported
  const localToVendor = new Map<string, string>(); // specifier → resolved app file
  const aliases = readAliases(targetDir);
  // realpath both sides of the refusal comparison: esbuild hands plugins REAL
  // paths, and e.g. macOS tmpdirs are symlinks — a naive relative() would
  // misread every file as "outside the app source root".
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const sourceRoot = real(
    (() => {
      const src = path.join(targetDir, "src");
      try {
        return statSync(src).isDirectory() ? src : targetDir;
      } catch {
        return targetDir;
      }
    })(),
  );

  // 1. Classify per anchor; collect what to vendor.
  for (const [anchorId, record] of Object.entries(records)) {
    const perImport: Record<string, ReturnType<typeof toManifestStatus>> = {};
    // Classify the PREPARED text when sync produced one — that is the baseline
    // the model will actually patch (no phantom wrapper import).
    for (const specifier of importSpecifiers(record.prepared ?? record.source, record.file)) {
      const cls = classifyImport(specifier);
      if (cls.kind === "vendor-npm") {
        perImport[specifier] = toManifestStatus(cls);
        npmToVendor.set(specifier, `${slug(specifier)}.js`);
      } else if (cls.kind === "shimmed" && specifier in SHIM_ENTRIES) {
        perImport[specifier] = toManifestStatus(cls);
        shimsToVendor.add(specifier);
      } else if (cls.kind === "vendor-local") {
        // App-local modules: bundle each (with its transitive local closure)
        // as a vendored ESM entry — the fast-edits benchmark showed inlining
        // these by hand dominates first-remix latency. Refusal rules apply to
        // the whole closure at bundle time; failures fall back to absent.
        const resolved = resolveModuleFile(
          specifier,
          path.resolve(targetDir, record.file),
          aliases,
        );
        if (resolved) {
          perImport[specifier] = toManifestStatus(cls); // real — verified by the bundle step
          localToVendor.set(specifier, resolved);
        } else {
          perImport[specifier] = {
            kind: "absent",
            alternative: "app-local module could not be resolved — inline its logic from the source",
          };
        }
      } else {
        perImport[specifier] = toManifestStatus(cls);
      }
    }
    anchors[anchorId] = perImport;
  }

  if (Object.keys(records).length === 0) {
    return { manifest: { anchors: {} }, report: ["env: no captured components — skipped"] };
  }

  mkdirSync(vendorDir, { recursive: true });

  // 2. Vendor pure-npm deps as ESM (react/react-dom externalized to the shim).
  const vendorSizes: Record<string, number> = {};
  let vendorTotal = 0;
  const vendorOne = async (contents: string) =>
    build({
      stdin: { contents, resolveDir: targetDir, loader: "js" },
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      external: ["react", "react-dom", "react/jsx-runtime"],
      logLevel: "silent",
    });
  for (const [specifier, outName] of npmToVendor) {
    try {
      // Re-export named AND default. Named-only packages (lucide-react,
      // date-fns) have no default, so esbuild errors on the default line —
      // retry with `export *` alone rather than marking the package absent
      // (Codex review).
      let result;
      try {
        result = await vendorOne(
          `export * from ${JSON.stringify(specifier)};\nexport { default } from ${JSON.stringify(specifier)};`,
        );
      } catch {
        result = await vendorOne(`export * from ${JSON.stringify(specifier)};`);
      }
      const code = result.outputFiles[0]!.text;
      writeFileSync(path.join(vendorDir, outName), code);
      vendorSizes[specifier] = code.length;
      vendorTotal += code.length;
      report.push(`env: vendored ${specifier} (${kb(code.length)})`);
    } catch (err) {
      // Fail-open: mark absent everywhere it appeared.
      for (const perImport of Object.values(anchors)) {
        if (perImport[specifier]) {
          perImport[specifier] = { kind: "absent", alternative: "could not bundle — reimplement or omit" };
        }
      }
      report.push(`env: could not vendor ${specifier} (${err instanceof Error ? err.message : String(err)}) — marked absent`);
    }
  }
  if (vendorTotal > VENDOR_SOFT_CAP) {
    const heavy = Object.entries(vendorSizes).sort((a, b) => b[1] - a[1]).slice(0, 3);
    report.push(
      `env: vendor bundle ${kb(vendorTotal)} exceeds the ${kb(VENDOR_SOFT_CAP)} soft cap; heaviest: ${heavy.map(([s, n]) => `${s} ${kb(n)}`).join(", ")}`,
    );
  }

  // 2b. Bundle each imported shim from @vendoai/sandbox-shims (react
  //     externalized) so `next/link`/`swr`/… actually resolve in-sandbox.
  const shimToVendor = new Map<string, string>();
  if (shimsToVendor.size > 0) {
    // Prefer the shims copy that scripts/bundle-assets.mjs ships next to the
    // built CLI (dist/shims/) — the published package cannot depend on the
    // private @vendoai/sandbox-shims. Fall back to resolving the workspace
    // package's dist via its main entry when running from source.
    const bundledShims = fileURLToPath(new URL("./shims/", import.meta.url));
    const shimsDist = existsSync(bundledShims)
      ? bundledShims
      : path.dirname(createRequire(import.meta.url).resolve("@vendoai/sandbox-shims"));
    for (const specifier of shimsToVendor) {
      const outName = `shim-${slug(specifier)}.js`;
      try {
        const entry = path.join(shimsDist, `${SHIM_ENTRIES[specifier]!}.js`);
        const result = await build({
          entryPoints: [entry],
          bundle: true,
          format: "esm",
          platform: "browser",
          write: false,
          external: ["react", "react-dom", "react/jsx-runtime"],
          logLevel: "silent",
        });
        const code = result.outputFiles[0]!.text;
        writeFileSync(path.join(vendorDir, outName), code);
        shimToVendor.set(specifier, outName);
        vendorSizes[specifier] = code.length;
        report.push(`env: shimmed ${specifier} (${kb(code.length)})`);
      } catch (err) {
        for (const perImport of Object.values(anchors)) {
          if (perImport[specifier]) {
            perImport[specifier] = { kind: "absent", alternative: "shim unavailable — reimplement or omit" };
          }
        }
        report.push(`env: could not bundle shim ${specifier} (${err instanceof Error ? err.message : String(err)}) — marked absent`);
      }
    }
  }

  // 2c. Vendor app-local modules. Each entry bundles its transitive LOCAL
  //     closure (relative + alias imports) while externalizing anything the
  //     import map resolves separately (react family, vendored npm, shims).
  //     Refusal rules run on every file the bundle touches — one server-only
  //     file anywhere in the closure fails that specifier to absent.
  const localVendored = new Map<string, string>();
  if (localToVendor.size > 0) {
    const markAbsent = (specifier: string, why: string) => {
      for (const perImport of Object.values(anchors)) {
        if (perImport[specifier]) {
          perImport[specifier] = {
            kind: "absent",
            alternative: "app-local module not vendored — inline its logic from the source",
          };
        }
      }
      report.push(`env: could not vendor local ${specifier} (${why}) — marked absent`);
    };
    const externals = new Set([
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      ...npmToVendor.keys(),
      ...Object.keys(SHIM_ENTRIES),
    ]);
    const localPlugin = {
      name: "vendo-local-closure",
      setup(pluginBuild: import("esbuild").PluginBuild) {
        // Aliases (@/x) resolve into the app; unknown bare imports NOT covered
        // by the import map must fail loudly, not ship as broken externals.
        pluginBuild.onResolve({ filter: /.*/ }, (args) => {
          if (args.kind === "entry-point") return null;
          const spec = args.path;
          if (/\.(css|scss|sass|less|png|jpe?g|gif|svg|webp|woff2?)$/.test(spec)) {
            return { path: spec, namespace: "vendo-inert-asset" };
          }
          if (spec.startsWith(".")) return null; // relative: esbuild bundles it
          const alias = aliases.find((a) => spec.startsWith(a.prefix));
          if (alias) {
            const resolved = resolveModuleFile(spec, args.importer, aliases);
            return resolved
              ? { path: resolved }
              : { errors: [{ text: `unresolvable alias import ${spec}` }] };
          }
          if (externals.has(spec)) return { path: spec, external: true };
          // @vendoai/shell never exists in-sandbox; a local module importing
          // it (e.g. its own VendoRemix wrapper) must not be vendored.
          if (spec === "@vendoai/shell") {
            return { errors: [{ text: "imports @vendoai/shell (host-only)" }] };
          }
          // Pure npm inside the closure (clsx, date-fns, …) that the COMPONENT
          // itself never imports: bundle it into this entry — it has no import
          // map row of its own, and it is ordinary client code.
          if (classifyImport(spec).kind === "vendor-npm") return null;
          return { errors: [{ text: `imports ${spec}, which the sandbox does not provide` }] };
        });
        pluginBuild.onLoad({ filter: /.*/, namespace: "vendo-inert-asset" }, () => ({
          contents: "export default {};",
          loader: "js",
        }));
        pluginBuild.onLoad({ filter: /\.(tsx?|jsx?|mjs|cjs)$/ }, (args) => {
          // Refusal rules guard APP code; bundled npm files (clsx & co) are
          // ordinary client packages — let esbuild's default loader take them.
          if (args.path.includes(`${path.sep}node_modules${path.sep}`)) return null;
          const content = readFileSync(args.path, "utf8");
          const refusal = refusalReason(real(args.path), content, sourceRoot);
          if (refusal) return { errors: [{ text: `${refusal} (${args.path})` }] };
          const ext = path.extname(args.path).slice(1);
          const loader = (ext === "cjs" || ext === "mjs" ? "js" : ext) as "ts" | "tsx" | "js" | "jsx";
          return { contents: content, loader };
        });
      },
    };
    for (const [specifier, file] of localToVendor) {
      const outName = `local-${slug(specifier)}.js`;
      try {
        const result = await build({
          entryPoints: [file],
          bundle: true,
          format: "esm",
          platform: "browser",
          write: false,
          plugins: [localPlugin],
          logLevel: "silent",
        });
        const code = result.outputFiles[0]!.text;
        writeFileSync(path.join(vendorDir, outName), code);
        localVendored.set(specifier, outName);
        vendorSizes[specifier] = code.length;
        vendorTotal += code.length;
        report.push(`env: vendored local ${specifier} (${kb(code.length)})`);
      } catch (err) {
        const msg =
          err && typeof err === "object" && "errors" in err
            ? ((err as { errors: { text: string }[] }).errors[0]?.text ?? String(err))
            : err instanceof Error
              ? err.message
              : String(err);
        markAbsent(specifier, msg);
      }
    }
  }

  // 3. Import map (blob-resolved at runtime by the stage; paths are relative).
  const importMap = {
    imports: Object.fromEntries([
      ...[...npmToVendor].map(([specifier, outName]) => [specifier, `./vendor/${outName}`]),
      ...[...shimToVendor].map(([specifier, outName]) => [specifier, `./vendor/${outName}`]),
      ...[...localVendored].map(([specifier, outName]) => [specifier, `./vendor/${outName}`]),
    ]),
  };
  writeFileSync(path.join(envDir, "import-map.json"), `${JSON.stringify(importMap, null, 2)}\n`);

  // 4. Host CSS from source, sanitized to zero fetchable URLs.
  const cssEntry = findCssEntry(targetDir);
  let hasCss = false;
  if (cssEntry) {
    const raw = opts.compileCss ? opts.compileCss(cssEntry) : readFileSync(cssEntry, "utf8");
    const { css, dropped } = sanitizeCss(raw);
    writeFileSync(path.join(envDir, "host.css"), css);
    hasCss = true;
    report.push(`env: host.css from ${path.relative(targetDir, cssEntry)}${dropped.length ? ` (dropped ${dropped.length} fetchable url(s))` : ""}`);
  } else {
    report.push("env: no globals.css found — sandbox keeps --vendo-* vars only");
  }

  // 4b. Tailwind JIT runtime (arbitrary utilities compile in-sandbox). Shipped
  //     only when @tailwindcss/browser resolves — the manifest records exactly
  //     what shipped so the prompt never claims a capability that is absent.
  let hasTailwind = false;
  try {
    const requireFrom = createRequire(import.meta.url);
    const twEntry = requireFrom.resolve("@tailwindcss/browser");
    const built = await build({
      entryPoints: [twEntry],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    writeFileSync(path.join(envDir, "tailwind.js"), built.outputFiles[0]!.text);
    hasTailwind = true;
    report.push(`env: tailwind.js (${kb(built.outputFiles[0]!.text.length)})`);
  } catch (err) {
    report.push(`env: Tailwind JIT not shipped (${err instanceof Error ? err.message : String(err)}) — prompt will not claim it`);
  }

  // 5. Manifest.
  const manifest: EnvManifest = {
    anchors,
    vendorSizes,
    styles: { css: hasCss, tailwind: hasTailwind },
  };
  writeFileSync(path.join(envDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // 6. Copy runtime artifacts into public/vendo/env for the stage to fetch.
  mirror(envDir, publicDir, report, targetDir);

  return { manifest, report };
}

function slug(specifier: string): string {
  return specifier.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}
function kb(n: number): string {
  return `${(n / 1024).toFixed(1)}KB`;
}
function mirror(from: string, to: string, report: string[], targetDir: string): void {
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    report.push(`env: copied to ${path.relative(targetDir, to)}`);
  } catch (err) {
    report.push(`env: could not copy to public/ (${err instanceof Error ? err.message : String(err)}) — serve .vendo/env yourself`);
  }
}
