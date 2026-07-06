import { defineConfig } from "vitest/config";
// testTimeout: the entrypoint tests cold-import the built dist, which loads the
// whole @vendoai/client+shell+react graph and can exceed 5s under parallel monorepo test load.
export default defineConfig({ test: { environment: "jsdom", globals: true, css: false, testTimeout: 60000 } });
