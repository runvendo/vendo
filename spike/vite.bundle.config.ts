import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    // Replace process.env.NODE_ENV so the bundle doesn't reference `process` at runtime
    // (the sandboxed iframe has no `process` global).
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    lib: { entry: "sample-bundle/entry.tsx", formats: ["es"], fileName: () => "host-bundle.js" },
    outDir: "public",
    emptyOutDir: false,
    // NOTE: do NOT externalize react/react-dom — bundle them in (single React in the sandbox).
  },
});
