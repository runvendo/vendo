import { mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { vendoHostPreset } from "../../src/build/preset";

const harnessDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * Builds the externalized host bundle using the reusable vendoHostPreset.
 * The preset encodes the two hard requirements from the F3a spike:
 *   1. React externalized (resolves to the stage's shared shim via import map).
 *   2. process.env.NODE_ENV defined (no bare `process` in the sandbox).
 *
 * Harness-specific overrides (output filename, emptyOutDir) are merged on top.
 */
export default mergeConfig(
  vendoHostPreset({
    entry: path.join(harnessDir, "sample-bundle/entry-ext.tsx"),
    version: "0.0.0-test",
  }),
  {
    root: harnessDir,
    build: {
      outDir: "public",
      emptyOutDir: false,
      lib: {
        fileName: () => "host-bundle-ext.js",
      },
    },
  },
);
