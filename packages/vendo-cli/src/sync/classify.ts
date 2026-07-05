/**
 * Classify every import in the captured components' closure into how it will
 * resolve inside the sandbox: real (vendored), shimmed (framework/data), or
 * absent (server-only / unknown). Deterministic; drives both vendoring and
 * the engine's environment manifest.
 */
import ts from "typescript";
import type { EnvImportStatus } from "@vendoai/core";

/** Framework modules replaced by identical-API shims (never bundled). */
export const SHIMMED: Record<string, string> = {
  "next/link": "renders an anchor; clicks navigate the host app via vendo.navigate",
  "next/image": "renders an img with the same prop surface",
  "next/navigation": "useRouter().push routes the host app via vendo.navigate",
  swr: "useSWR resolves anchor data / declared queries; the fetcher never runs",
};

/** Server-only modules that cannot exist in the sandbox. */
const SERVER_ONLY = new Set([
  "next/headers",
  "next/server",
  "server-only",
  "fs",
  "node:fs",
  "path",
  "node:path",
  "crypto",
  "node:crypto",
]);

export type ImportClass =
  | { kind: "vendor-npm"; specifier: string }
  | { kind: "vendor-local"; specifier: string }
  | { kind: "shimmed"; specifier: string; note: string }
  | { kind: "absent"; specifier: string; alternative: string };

const isRelativeOrAlias = (s: string) => s.startsWith(".") || s.startsWith("@/");

export function classifyImport(specifier: string): ImportClass {
  if (specifier in SHIMMED) return { kind: "shimmed", specifier, note: SHIMMED[specifier]! };
  if (SERVER_ONLY.has(specifier)) {
    return { kind: "absent", specifier, alternative: "server-only — bind data via { $path } into data.anchor" };
  }
  if (specifier === "react" || specifier === "react-dom" || specifier.startsWith("react/")) {
    // Supplied by the stage's shared React shim, not vendored.
    return { kind: "shimmed", specifier, note: "shared React runtime (provided by the stage)" };
  }
  if (isRelativeOrAlias(specifier)) return { kind: "vendor-local", specifier };
  if (specifier.startsWith("next/")) {
    return { kind: "absent", specifier, alternative: "no shim yet — reimplement or omit" };
  }
  return { kind: "vendor-npm", specifier };
}

/** Bare import specifiers in a source file (deduped, in source order). */
export function importSpecifiers(source: string, fileName = "x.tsx"): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  for (const statement of sf.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const s = statement.moduleSpecifier.text;
      if (s !== "@vendoai/shell" && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

export function toManifestStatus(cls: ImportClass): EnvImportStatus {
  switch (cls.kind) {
    case "vendor-npm":
    case "vendor-local":
      return { kind: "real" };
    case "shimmed":
      return { kind: "shimmed", note: cls.note };
    case "absent":
      return { kind: "absent", alternative: cls.alternative };
  }
}
