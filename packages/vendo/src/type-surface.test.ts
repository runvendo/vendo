import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const packageDir = fileURLToPath(new URL("..", import.meta.url)); // packages/vendo

// Every host-facing type a host names when wiring or reaching into the umbrella.
// Core types arrive via `export type * from "@vendoai/core"` (verified: ActAs,
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
  // agent
  "VendoAgent",
  "Thread",
  "ThreadSummary",
  // actions
  "ActionsRegistry",
  "Connector",
  "ExtractedTool",
  "SyncReport",
  // guard
  "Judge",
  "PolicyConfig",
  "PolicyFile",
  "PolicyFn",
  "PolicyRule",
  "Scanner",
  "VendoGuard",
  // apps
  "AppsRuntime",
  "EditResult",
  "OpenSurface",
  "SandboxAdapter",
  "SandboxMachine",
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
  // wave closes; the rest of @vendoai/mcp's surface (McpDoor, AppsPort,
  // McpDoorConfig, McpRunContext) is umbrella-internal — no `vendo.mcp`
  // handle exists on the Vendo interface (09 §2) — so it is deliberately
  // NOT re-exported.
  "HostOAuthAdapter",
];

const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { force: true });
});

/** Type-check a fixture that `import type`s `names` from the source root entry.
 *  Returns tsc's combined output on failure, or null when it exits clean. */
function typecheckImports(names: string[]): string | null {
  // Written at the package root so `./src/index.js` and node_modules both
  // resolve; a unique name keeps parallel runs isolated and out of the build
  // (tsconfig `include` is `src/**`, so a root-level file is never compiled).
  const fixturePath = join(packageDir, `.type-surface.${process.pid}.${Math.random().toString(36).slice(2)}.ts`);
  fixtures.push(fixturePath);
  writeFileSync(fixturePath, `import type { ${names.join(", ")} } from "./src/index.js";\n`);
  try {
    execFileSync(
      process.execPath,
      [tsc, fixturePath, "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
        "--moduleResolution", "Bundler", "--skipLibCheck", "--esModuleInterop"],
      { cwd: packageDir, stdio: "pipe" },
    );
    return null;
  } catch (error) {
    const err = error as { stdout?: Buffer; stderr?: Buffer };
    return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
  }
}

describe("09-vendo §1 — umbrella root type surface", () => {
  it("re-exports every host-facing type from the source root entry", () => {
    const failure = typecheckImports(HOST_FACING_TYPES);
    expect(failure, failure ?? "").toBeNull();
  });

  it("has teeth: a missing re-export fails the tsc gate with TS2305", () => {
    // Proves the mechanism genuinely catches a dropped re-export, so the
    // assertion above cannot silently pass if the surface regresses.
    const failure = typecheckImports(["__DefinitelyNotAVendoRootExport"]);
    expect(failure).not.toBeNull();
    expect(failure).toContain("TS2305");
  });
});
