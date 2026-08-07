import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 09-vendo §2.1 / corpus-triage Task 9 — a bundler-style module-graph probe.
 *
 * Webpack (and every other bundler) resolves EVERY specifier in an ES
 * module's static `export ... from "x"` / `import ... from "x"` statements,
 * AND every literal-string `import("x")` call, to build its module graph —
 * regardless of whether the imported binding is ever used or the dynamic
 * import ever executes. Tree-shaking only trims the emitted bundle
 * afterwards; it does not skip resolution. So a host that imports anything
 * from "@vendoai/vendo/server" statically re-resolves every module reachable
 * from server.ts, even ones it never calls.
 *
 * Before this fix, `server.ts` re-exported all five auth presets from the
 * single barrel `auth-presets/index.ts`, which re-exported auth-js.ts and
 * clerk.ts alongside the others in the SAME file. Any host — even one using
 * no preset at all — therefore had `@auth/core/jwt` and `@clerk/backend`
 * reachable from its `@vendoai/vendo/server` import, and failed to build
 * without those optional peers installed ("Can't resolve '@auth/core/jwt'").
 *
 * This walker mirrors that resolution behavior (minus type-only imports,
 * which TypeScript erases before any bundler sees them) and asserts the
 * fixed server entry never reaches the optional peers, while confirming the
 * probe isn't vacuous: the per-preset modules still do, on their own.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = join(HERE, "..", "server.ts");
const AUTH_PRESETS_INDEX = join(HERE, "index.ts");
const AUTH_JS_TS = join(HERE, "auth-js.ts");
const CLERK_TS = join(HERE, "clerk.ts");
const ACTIONS_PRESETS_INDEX = join(HERE, "..", "..", "..", "actions", "src", "presets", "index.ts");

/** Every top-level `import`/`export ... from "spec"` statement (skipping
    pure `import type` / `export type`, which TypeScript erases entirely —
    no bundler ever sees them) plus every literal-string `import("spec")`
    call anywhere in the file (a bundler resolves these too, to build the
    async chunk, even if the call site never executes). */
function extractValueSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const statementRe = /^(?:import|export)\b[\s\S]*?;/gm;
  let match: RegExpExecArray | null;
  while ((match = statementRe.exec(source)) !== null) {
    const statement = match[0];
    if (/^(?:import|export)\s+type\b/.test(statement.trim())) continue;
    const fromMatch = /from\s+["']([^"']+)["']/.exec(statement);
    if (fromMatch) specifiers.push(fromMatch[1]!);
  }
  const dynamicRe = /\bimport\(\s*["']([^"']+)["']/g;
  while ((match = dynamicRe.exec(source)) !== null) specifiers.push(match[1]!);
  return specifiers;
}

/** Resolve a relative specifier (compiled-output ".js" extension) back to
    its TypeScript source file on disk. */
function resolveRelative(fromFile: string, specifier: string): string {
  const dir = dirname(fromFile);
  const target = join(dir, specifier);
  const candidates = [
    target,
    target.replace(/\.jsx?$/, ".ts"),
    target.replace(/\.jsx$/, ".tsx"),
    `${target}.ts`,
    `${target}.tsx`,
    join(target, "index.ts"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`module-graph probe: cannot resolve "${specifier}" from ${fromFile}`);
  }
  return found;
}

/** BFS the module graph from `rootFile`: relative specifiers are resolved
    and walked further; bare/package specifiers (node_modules, workspace
    packages) are leaves — recorded but never opened, exactly like a bundler
    treats an external module boundary. */
function collectReachableSpecifiers(rootFile: string): Set<string> {
  const reached = new Set<string>();
  const visitedFiles = new Set<string>();
  const queue = [rootFile];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visitedFiles.has(file)) continue;
    visitedFiles.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of extractValueSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        queue.push(resolved);
      } else {
        reached.add(specifier);
      }
    }
  }
  return reached;
}

describe("auth-presets module graph (bundler-style reachability)", () => {
  it("@vendoai/vendo/server never reaches @auth/core or @clerk/backend", () => {
    const reached = collectReachableSpecifiers(SERVER_TS);
    expect(reached.has("@auth/core/jwt")).toBe(false);
    expect(reached.has("@auth/core")).toBe(false);
    expect(reached.has("@clerk/backend")).toBe(false);
  });

  it("the internal auth-presets barrel never reaches @auth/core or @clerk/backend either", () => {
    // Defense in depth: server.ts routes hostAuthPresetConformance + shared
    // types through this barrel, so the barrel itself must stay clean, not
    // just server.ts's current export list.
    const reached = collectReachableSpecifiers(AUTH_PRESETS_INDEX);
    expect(reached.has("@auth/core/jwt")).toBe(false);
    expect(reached.has("@clerk/backend")).toBe(false);
  });

  it("@vendoai/actions/presets never reaches @auth/core (authJsPreset moved to its own subpath)", () => {
    const reached = collectReachableSpecifiers(ACTIONS_PRESETS_INDEX);
    expect(reached.has("@auth/core/jwt")).toBe(false);
    expect(reached.has("@auth/core")).toBe(false);
  });

  it("sanity: the probe isn't vacuous — auth-js.ts on its own DOES reach @auth/core/jwt", () => {
    const reached = collectReachableSpecifiers(AUTH_JS_TS);
    expect(reached.has("@auth/core/jwt")).toBe(true);
  });

  it("sanity: clerk.ts on its own DOES reach @clerk/backend", () => {
    const reached = collectReachableSpecifiers(CLERK_TS);
    expect(reached.has("@clerk/backend")).toBe(true);
  });
});
