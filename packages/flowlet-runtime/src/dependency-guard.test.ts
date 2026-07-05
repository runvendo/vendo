/**
 * The embedded-mode architectural guarantee (architecture Decision 1), kept
 * honest in CI forever: @flowlet/runtime never imports a database, queue, or
 * HTTP server. Two layers:
 *
 *  1. package.json runtime dependencies are ALLOWLISTED — adding any new
 *     dependency fails this test until it is consciously reviewed and added.
 *  2. every src/ import is scanned against a denylist of cloud concerns
 *     (db drivers, queues, http servers, Node server builtins).
 *
 * If you are here because this test failed: the fix is almost never "add it
 * to the allowlist". Cloud concerns belong in apps/cloud behind a seam.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_ROOT = join(__dirname, "..");

/** Every runtime dependency, consciously reviewed. Keep alphabetical. */
const ALLOWED_DEPENDENCIES = [
  "@ai-sdk/anthropic",
  "@ai-sdk/mcp",
  "@ai-sdk/provider",
  "@composio/core",
  "@composio/vercel",
  "@flowlet/core",
  // Audited pure-JS hashing (remix envelope seal + baseline hashes). Chosen
  // over node:crypto because the runtime ships to browsers too — node
  // builtins break browser bundles (example-basic, reviewed 2026-07-04).
  "@noble/hashes",
  "ai",
  "croner",
  "jsonata",
  "sucrase",
  "zod",
];

/** Cloud concerns that must never appear anywhere near this package. */
const FORBIDDEN_MODULES = [
  // databases / ORMs
  "pg", "postgres", "mysql", "mysql2", "sqlite3", "better-sqlite3", "libsql",
  "@prisma/client", "prisma", "drizzle-orm", "knex", "typeorm", "sequelize",
  "mongodb", "mongoose", "redis", "ioredis",
  // queues / job runners
  "pg-boss", "bullmq", "bull", "bee-queue", "amqplib", "kafkajs", "agenda",
  // http servers / frameworks
  "express", "fastify", "koa", "hono", "@hapi/hapi", "restify", "next",
  // Node server builtins, plus node:module (createRequire is a require()
  // escape hatch that would bypass this scan)
  "http", "https", "net", "tls", "http2", "dgram", "cluster", "module",
  "node:http", "node:https", "node:net", "node:tls", "node:http2", "node:dgram", "node:cluster",
  "node:module",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

/** import/export-from/require specifiers in a source file — including bare
 *  side-effect imports (an import keyword directly followed by a string,
 *  with no from clause; spelling one out here would trip the scan). */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

/** "pg/lib/foo" and "node:http" both resolve to their forbidden root. */
function moduleRoot(specifier: string): string {
  if (specifier.startsWith(".")) return specifier;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

describe("dependency guard: @flowlet/runtime is portable (Decision 1)", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("runtime dependencies are exactly the reviewed allowlist", () => {
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([...ALLOWED_DEPENDENCIES].sort());
  });

  it("no dependency or devDependency is a db, queue, or http server", () => {
    const all = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const offending = all.filter((name) => FORBIDDEN_MODULES.includes(name));
    expect(offending).toEqual([]);
  });

  it("no shipped src/ file imports a db, queue, http server, or Node server builtin", () => {
    const offending: string[] = [];
    for (const file of sourceFiles(join(PKG_ROOT, "src"))) {
      // Test files are excluded from the build (tsconfig `exclude`) and never
      // reach dist, so they may stand up local fixtures — e.g. the MCP
      // contract test's in-process node:http server. The shipped-runtime
      // guarantee this guard protects is unaffected.
      if (/\.test\.(ts|tsx)$/.test(file)) continue;
      for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
        if (FORBIDDEN_MODULES.includes(moduleRoot(specifier))) {
          offending.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  it("dynamic imports in src/ use only literal specifiers", () => {
    // A computed specifier would evade the literal scan above, so ban the
    // construct outright: every dynamic import must open with a plain quote.
    // (Static-lint limits beyond this are accepted: a determined author can
    // always evade a regex; this guard exists to catch honest mistakes.)
    const nonLiteralDynamicImport = /(?<![A-Za-z0-9_$.])import\s*\(\s*(?!["'])/;
    const offending: string[] = [];
    for (const file of sourceFiles(join(PKG_ROOT, "src"))) {
      if (nonLiteralDynamicImport.test(readFileSync(file, "utf8"))) {
        offending.push(file);
      }
    }
    expect(offending).toEqual([]);
  });
});
