/**
 * Builds the clone's sandbox host bundle (catalog + registered host
 * components) with the @flowlet/stage build preset — React externalized to the
 * stage's shared shim, NODE_ENV defined for the processless iframe.
 */
import { defineConfig, mergeConfig } from "vite";
import { fileURLToPath } from "node:url";
import { flowletHostPreset } from "@flowlet/stage/build";

const here = fileURLToPath(new URL(".", import.meta.url));

export default mergeConfig(
  flowletHostPreset({
    entry: here + "entry.js",
    version: "gmail-demo",
    outDir: here + "dist",
  }),
  defineConfig({
    // Don't mirror the app's public/ into the bundle outDir.
    publicDir: false,
  }),
);
