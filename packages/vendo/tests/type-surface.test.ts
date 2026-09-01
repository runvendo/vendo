import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// 09-vendo §1: the umbrella root (`@vendoai/vendo`) re-exports "root types
// re-exported from core (+ each block's primary types)". This is a PURE TYPE
// surface — every export in src/index.ts is `export type`, and types are erased
// at runtime. vitest runs under esbuild (no typechecking) and the package
// tsconfig EXCLUDES *.test.ts, so a plain `import type` here would be silently
// unchecked and prove nothing. Instead we shell a real `tsc --noEmit` over a
// generated fixture that `import type`s each name from the source root entry: a
// missing re-export makes tsc emit TS2305 and exit non-zero, which
// execFileSync surfaces as a throw. Removing any single re-export from
// src/index.ts turns this suite red (proven by mutation in the wave report).
// Deliberately checks the SOURCE entry, not the published `@vendoai/vendo`
// surface: source is deterministic against the working tree, while dist would
// silently test stale build output; exports-map/dist breakage is a different
// failure class, covered by the clean-room publish verification at release.

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const packageDir = fileURLToPath(new URL("..", import.meta.url)); // packages/vendo

// Every host-facing type a host names when wiring or reaching into the umbrella.
// Core types arrive via `export type * from "../src/core/index.js"` (verified: ActAs,
// SecretsProvider, StoreAdapter, VendoTheme are all core exports); the rest are
// each block's primary/host-facing types re-exported explicitly.
const HOST_FACING_TYPES = [
  // core (through `export type *`)
  "Principal",
  "ActAs",
  "SecretsProvider",
  "StoreAdapter",
  "VendoTheme",
  "RunContext",
  "AppDocument",
  "AppId",
  "RunId",
  "Json",
  "ToolRegistry",
  "Guard",
  "ToolOutcome",
  "ApprovalRequest",
  "PermissionGrant",
  "AuditEvent",
  // store
  "VendoStore",
  // the thread lifecycle
  "Thread",
  "ThreadSummary",
  // actions
  "ActionsRegistry",
  "Connector",
  "ExtractedTool",
  "SyncReport",
  // actions — the file shapes the in-memory createVendo({ profile }) pieces
  // name (Task 15a); VendoTheme rides the core `export type *`.
  "CatalogFile",
  "OverridesFile",
  // guard
  "Judge",
  "PolicyConfig",
  "PolicyFile",
  "PolicyFn",
  "PolicyRule",
  "VendoGuard",
  // apps
  "AppsRuntime",
  "EditResult",
  "OpenSurface",
  "SandboxAdapter",
  "SandboxMachine",
  "SeedDrift",
  "VersionEntry",
  // automations
  "AutomationsEngine",
  "RunPlan",
  "RunRecord",
  "RunStatus",
  // ui
  "VendoClient",
  "VendoClientConfig",
  // mcp — the host implements HostOAuthAdapter to open the door
  // (createVendo({ mcp: true, oauth }), 10-mcp §3). This is the gap this
  // wave closes; the rest of @vendoai/vendo/mcp's surface (McpDoor,
  // McpDoorConfig, McpRunContext) is umbrella-internal — no `vendo.mcp`
  // handle exists on the Vendo interface (09 §2) — so it is deliberately
  // NOT re-exported.
  "HostOAuthAdapter",
];

/** Every fixture this file checks: the names it `import type`s, and the entry
 *  it names them from. */
const FIXTURES = {
  root: { entry: "./src/index.js", names: HOST_FACING_TYPES },
  // The hosted try venue composes typed createVendo({ profile }) pieces from
  // @vendoai/vendo/server alone — every piece type must resolve there.
  server: {
    entry: "./src/server.js",
    names: ["CreateVendoConfig", "CatalogFile", "ExtractedTool", "OverridesFile", "VendoTheme"],
  },
  // Proves the mechanism genuinely catches a dropped re-export, so the
  // assertions above cannot silently pass if the surface regresses.
  teeth: { entry: "./src/index.js", names: ["__DefinitelyNotAVendoRootExport"] },
} satisfies Record<string, { entry: string; names: readonly string[] }>;

type FixtureName = keyof typeof FIXTURES;

// Written at the package root so `./src/index.js` and node_modules both resolve;
// the pid keeps concurrent runs isolated, and a dotfile at the root is out of
// the build (tsconfig `include` is `src/**`).
const pathOf = (name: FixtureName): string => join(packageDir, `.type-surface.${process.pid}.${name}.ts`);

/** tsc's diagnostics for each fixture, from ONE invocation.
 *
 *  A tsc run's cost is the source tree it loads (~4.5s here — the root entry
 *  reaches the whole package plus the DOM lib), not the one-line fixture on top
 *  of it, so a checker per fixture paid for the same tree three times. One
 *  program over all three fixtures costs what one of them did, and every
 *  diagnostic names the file it came from, so each test still reads its OWN
 *  verdict. A diagnostic that names no fixture is a failure of the run itself
 *  and lands on all of them, never swallowed. */
function typecheckFixtures(): Record<FixtureName, string | null> {
  const names = Object.keys(FIXTURES) as FixtureName[];
  for (const name of names) {
    writeFileSync(pathOf(name), `import type { ${FIXTURES[name].names.join(", ")} } from "${FIXTURES[name].entry}";\n`);
  }
  let output = "";
  try {
    execFileSync(
      process.execPath,
      // `--jsx` and `--lib` are the fold's addition, and they are not optional:
      // the root entry re-exports the ui barrel, which used to resolve to another
      // package's emitted `.d.ts` and now resolves to `src/ui/context.tsx` — real
      // TSX against the DOM. Without them tsc stops at TS6142 on every hook and
      // the surface it was asked about is never checked. Mirrors tsconfig.base.
      [tsc, ...names.map(pathOf), "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
        "--moduleResolution", "Bundler", "--skipLibCheck", "--esModuleInterop",
        "--jsx", "react-jsx", "--lib", "ES2022,DOM,DOM.Iterable"],
      { cwd: packageDir, stdio: "pipe" },
    );
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    output = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
  }
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const unattributed = lines.filter((line) => !names.some((name) => line.startsWith(basename(pathOf(name)))));
  return Object.fromEntries(names.map((name) => {
    const own = [...lines.filter((line) => line.startsWith(basename(pathOf(name)))), ...unattributed];
    return [name, own.length === 0 ? null : own.join("\n")];
  })) as Record<FixtureName, string | null>;
}

let failures: Record<FixtureName, string | null>;
beforeAll(() => { failures = typecheckFixtures(); });
afterAll(() => {
  for (const name of Object.keys(FIXTURES) as FixtureName[]) rmSync(pathOf(name), { force: true });
});

describe("09-vendo §1 — umbrella root type surface", () => {
  it("re-exports every host-facing type from the source root entry", () => {
    expect(failures.root, failures.root ?? "").toBeNull();
  });

  it("names the profile piece types beside createVendo on the server entry (Task 15a)", () => {
    expect(failures.server, failures.server ?? "").toBeNull();
  });

  it("has teeth: a missing re-export fails the tsc gate with TS2305", () => {
    expect(failures.teeth).not.toBeNull();
    expect(failures.teeth).toContain("TS2305");
  });
});
