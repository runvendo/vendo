#!/usr/bin/env node
// Zero-dependency stub: `npx vendo <args>` delegates to @vendoai/cli, which
// owns the actual CLI (its own bin is also named `vendo`, but hosts install
// this umbrella package instead, so this forwards through npx).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

// On Windows npx resolves to npx.cmd, which CreateProcess can't execute
// directly (and shell:true would reintroduce shell-quoting risk).
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npx, ["-y", `@vendoai/cli@${version}`, ...process.argv.slice(2)], {
  stdio: "inherit",
});

child.on("error", (err) => {
  console.error(`vendo: could not launch \`npx @vendoai/cli@${version}\`: ${err.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
