#!/usr/bin/env node
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const rootEntry = require.resolve("@vendoai/vendo");
const canonicalBin = new URL("../bin/vendo.mjs", pathToFileURL(rootEntry));
await import(canonicalBin.href);
