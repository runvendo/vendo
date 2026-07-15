import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(packageDir, "src/tree/served-app/entry.tsx");
const output = resolve(packageDir, "../apps/src/scaffold/tree-renderer.gen.ts");

const result = await build({
  configFile: false,
  root: packageDir,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    write: false,
    minify: "esbuild",
    target: "es2020",
    lib: {
      entry,
      name: "VendoServedTreeRenderer",
      formats: ["iife"],
      fileName: () => "vendo-served-tree-renderer.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});

const outputs = Array.isArray(result) ? result.flatMap((entryResult) => entryResult.output) : result.output;
const chunk = outputs.find((item) => item.type === "chunk");
if (!chunk || chunk.type !== "chunk") throw new Error("Vite did not emit the served-app renderer chunk");

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `/**
 * Generated from packages/ui's production tree renderer. Do not edit.
 *
 * Regenerate: pnpm --filter @vendoai/ui build:served-renderer
 */
export const TREE_RENDERER_SOURCE: string = ${JSON.stringify(chunk.code.trim())};\n`,
  "utf8",
);
console.log(`[ui] generated served-app tree renderer (${chunk.code.length} bytes)`);
