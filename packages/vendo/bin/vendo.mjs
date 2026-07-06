#!/usr/bin/env node
// Zero-dependency stub: `vendo <args>` delegates to @vendoai/cli, which owns
// the actual CLI. Prefers a host-installed @vendoai/cli (Node resolution walks
// up from this stub into the host's node_modules — it is NOT a dep of vendo,
// so this only hits when the host installed it) for hermetic/offline builds;
// falls back to npx otherwise. Preferring the local install also means the
// `vendo` bin behaves identically to @vendoai/cli's own when both are present.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
const args = process.argv.slice(2);

let cmd, cmdArgs;
try {
  const cliPkgPath = require.resolve("@vendoai/cli/package.json");
  const cliPkg = require(cliPkgPath);
  const cliBin = typeof cliPkg.bin === "string" ? cliPkg.bin : cliPkg.bin.vendo;
  cmd = process.execPath;
  cmdArgs = [join(dirname(cliPkgPath), cliBin), ...args];
} catch {
  // On Windows npx resolves to npx.cmd, which CreateProcess can't execute
  // directly (and shell:true would reintroduce shell-quoting risk).
  cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  cmdArgs = ["-y", `@vendoai/cli@${version}`, ...args];
}

const child = spawn(cmd, cmdArgs, { stdio: "inherit" });

child.on("error", (err) => {
  console.error(`vendo: could not launch @vendoai/cli (${cmd}): ${err.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
