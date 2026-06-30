import { defineConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

export interface FlowletHostPresetOptions {
  /** Entry point for the host component bundle (relative to vite root, or absolute). */
  entry: string;
  /** Semantic version stamped into the bundle via __FLOWLET_BUNDLE_VERSION__. */
  version: string;
  /** Output directory; defaults to "dist". */
  outDir?: string;
}

/**
 * Vite preset for building a Flowlet host bundle.
 *
 * Encodes the two hard requirements discovered in the F3a spike:
 *  1. Externalize React (react, react-dom, react-dom/client, react/jsx-runtime)
 *     so the stage shares a single React instance via its import map.
 *  2. Define process.env.NODE_ENV — the sandbox has no `process` global and
 *     React throws without this define.
 *
 * Also stamps the bundle with __FLOWLET_BUNDLE_VERSION__ for traceability.
 */
export function flowletHostPreset(opts: FlowletHostPresetOptions): UserConfig {
  return defineConfig({
    plugins: [react()],
    define: {
      "process.env.NODE_ENV": '"production"',
      __FLOWLET_BUNDLE_VERSION__: JSON.stringify(opts.version),
    },
    build: {
      lib: {
        entry: opts.entry,
        formats: ["es"],
        fileName: () => "host-bundle",
      },
      outDir: opts.outDir ?? "dist",
      rollupOptions: {
        external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
      },
    },
  });
}
