import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const demoNodeModules = resolve(repoRoot, "apps/demo-accounting/node_modules");

export default {
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(demoNodeModules, "react") },
      { find: /^react\/(.+)$/, replacement: `${resolve(demoNodeModules, "react")}/$1` },
      { find: /^react-dom$/, replacement: resolve(demoNodeModules, "react-dom") },
      { find: /^react-dom\/(.+)$/, replacement: `${resolve(demoNodeModules, "react-dom")}/$1` },
      { find: /^framer-motion$/, replacement: resolve(demoNodeModules, "framer-motion") },
    ],
  },
  server: {
    fs: { allow: [repoRoot] },
  },
};
