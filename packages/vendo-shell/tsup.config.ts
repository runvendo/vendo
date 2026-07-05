import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // fluidkit is first-party IP vendored as a local tarball; it must be
  // bundled into the published dist (a file: dependency can't ship to npm).
  // Everything else (react, motion, @vendoai/*, ...) stays external.
  noExternal: ["fluidkit"],
  // Keep CSS imports as-is in the output (the previous tsc build emitted them
  // verbatim): "./styles.css" resolves to the copied dist/styles.css and
  // "katex/dist/katex.min.css" resolves from the katex dependency, both
  // handled by the consuming app's bundler. Without this, esbuild would
  // extract the CSS to dist/index.css and strip the imports, so consumers
  // would silently lose the shell's styles.
  external: [/\.css$/],
  onSuccess: "cp src/styles.css dist/styles.css",
});
