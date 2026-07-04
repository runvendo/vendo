/**
 * `flowlet sync` environment build: from the captured component sources,
 * produce the vendored dependency graph, import map, sanitized host CSS, and
 * the env manifest, written under `.flowlet/env/` and copied to
 * `public/flowlet/env/` for the stage's blob pipeline to fetch.
 *
 * Fail-open per item: a dep that will not bundle, or a missing stylesheet, is
 * reported and the anchor keeps whatever it can. The env NEVER fails the host
 * build for a classification gap.
 */
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { EnvManifest, RemixSourceRecord } from "@flowlet/core";
import { classifyImport, importSpecifiers, toManifestStatus } from "./classify.js";
import { sanitizeCss } from "./host-css.js";

const VENDOR_SOFT_CAP = 2 * 1024 * 1024;

/** Framework/data specifier → @flowlet/sandbox-shims source subpath. Each is
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
  const envDir = path.join(targetDir, ".flowlet", "env");
  const publicDir = path.join(targetDir, "public", "flowlet", "env");
  const vendorDir = path.join(envDir, "vendor");

  const anchors: EnvManifest["anchors"] = {};
  const npmToVendor = new Map<string, string>(); // specifier → vendor entry file
  const shimsToVendor = new Set<string>(); // shimmed specifiers actually imported

  // 1. Classify per anchor; collect what to vendor.
  for (const [anchorId, record] of Object.entries(records)) {
    const perImport: Record<string, ReturnType<typeof toManifestStatus>> = {};
    for (const specifier of importSpecifiers(record.source, record.file)) {
      const cls = classifyImport(specifier);
      if (cls.kind === "vendor-npm") {
        perImport[specifier] = toManifestStatus(cls);
        npmToVendor.set(specifier, `${slug(specifier)}.js`);
      } else if (cls.kind === "shimmed" && specifier in SHIM_ENTRIES) {
        perImport[specifier] = toManifestStatus(cls);
        shimsToVendor.add(specifier);
      } else if (cls.kind === "vendor-local") {
        // Local-closure vendoring isn't built yet — do NOT tell the model these
        // resolve (Codex review: the manifest was claiming "real" while env
        // never vendored them). Instruct inlining the helper instead.
        perImport[specifier] = {
          kind: "absent",
          alternative: "app-local helper not vendored — inline its logic from the source",
        };
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

  // 2b. Bundle each imported shim from @flowlet/sandbox-shims (react
  //     externalized) so `next/link`/`swr`/… actually resolve in-sandbox.
  const shimToVendor = new Map<string, string>();
  if (shimsToVendor.size > 0) {
    const requireFrom = createRequire(import.meta.url);
    // Resolve the package's dist dir via its main entry (only "." is exported).
    const shimsDist = path.dirname(requireFrom.resolve("@flowlet/sandbox-shims"));
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

  // 3. Import map (blob-resolved at runtime by the stage; paths are relative).
  const importMap = {
    imports: Object.fromEntries([
      ...[...npmToVendor].map(([specifier, outName]) => [specifier, `./vendor/${outName}`]),
      ...[...shimToVendor].map(([specifier, outName]) => [specifier, `./vendor/${outName}`]),
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
    report.push("env: no globals.css found — sandbox keeps --flowlet-* vars only");
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

  // 6. Copy runtime artifacts into public/flowlet/env for the stage to fetch.
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
    report.push(`env: could not copy to public/ (${err instanceof Error ? err.message : String(err)}) — serve .flowlet/env yourself`);
  }
}
