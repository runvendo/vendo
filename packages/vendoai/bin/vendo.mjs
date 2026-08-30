#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// The alias keeps the `vendo` bin so `npx vendoai@latest …` still works and
// hops to the canonical one, which carries the CLI again.
const rootEntry = require.resolve("@vendoai/vendo");
const canonicalBin = new URL("../bin/vendo.mjs", pathToFileURL(rootEntry));
await import(canonicalBin.href);
