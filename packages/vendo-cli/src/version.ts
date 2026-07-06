/**
 * The published CLI version, used by `--version` and telemetry events.
 *
 * Vite's `define` (see vite.config.ts) textually replaces
 * `__VENDO_CLI_VERSION__` with the real version at build time, so the built
 * dist/cli.js never touches the filesystem for this. Unit tests and dev
 * execution import src/ directly (unbuilt) — there the identifier is just an
 * undeclared global, so `typeof` safely reports "undefined" and we fall back
 * to reading package.json next to this module.
 */
import { createRequire } from "node:module";

declare const __VENDO_CLI_VERSION__: string | undefined;

function readPackageVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  return pkg.version;
}

export const CLI_VERSION: string =
  typeof __VENDO_CLI_VERSION__ !== "undefined" ? __VENDO_CLI_VERSION__ : readPackageVersion();
