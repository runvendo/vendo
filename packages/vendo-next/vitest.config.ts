import { defineConfig } from "vitest/config";
// All of this package's tests moved to @vendoai/client along with the code
// they covered; only re-export shims remain here, so no test files are
// expected — pass rather than fail on an empty suite.
export default defineConfig({ test: { environment: "jsdom", globals: true, passWithNoTests: true } });
