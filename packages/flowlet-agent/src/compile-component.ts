import { transform } from "sucrase";

/**
 * Compile a generated component's authored source (JSX and/or TypeScript) to
 * plain ESM the sandbox can import. Uses the AUTOMATIC JSX runtime in
 * PRODUCTION mode, so JSX becomes `jsx`/`jsxs` imports from "react/jsx-runtime"
 * (which the sandbox's React shim provides) — the author need not import React.
 * Plain-JS `React.createElement` source passes through essentially unchanged.
 * Throws on a syntax error (caller converts to a model-correctable error).
 */
export function compileComponentSource(source: string): string {
  return transform(source, {
    transforms: ["jsx", "typescript"],
    jsxRuntime: "automatic",
    production: true,
    // sucrase needs a filePath hint for TS; a virtual name is fine.
    filePath: "component.tsx",
  }).code;
}
