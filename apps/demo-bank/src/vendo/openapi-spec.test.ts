/**
 * Keeps Maple's OpenAPI spec honest: every operation must correspond to a real
 * route handler, and the adapter must derive a sane, policy-ready toolset from
 * it (ENG-202 — the spec is the host's contract for the agent's tools).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openApiToHostTools } from "@vendoai/core";
import spec from "../../openapi.json";
import { mapleHostToolDefs } from "./host-tools";

const APP_DIR = join(__dirname, "..", "app");

/** `/api/accounts/{id}/transactions` → `src/app/api/accounts/[id]/transactions/route.ts` */
function routeFileFor(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^\{(.+)\}$/, "[$1]"));
  return join(APP_DIR, ...segments, "route.ts");
}

describe("openapi.json ↔ route handlers", () => {
  const paths = Object.entries(spec.paths as Record<string, Record<string, unknown>>);

  it("covers the API surface", () => {
    expect(paths.length).toBeGreaterThanOrEqual(14);
  });

  it.each(paths)("path %s has a matching route handler", (path, item) => {
    const file = routeFileFor(path);
    expect(existsSync(file), `missing route file: ${file}`).toBe(true);
    const source = readFileSync(file, "utf8");
    for (const method of Object.keys(item)) {
      expect(source).toMatch(new RegExp(`export async function ${method.toUpperCase()}\\b`));
    }
  });
});

describe("mapleHostToolDefs", () => {
  it("derives one tool per operation with unique names", () => {
    const names = mapleHostToolDefs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("listAccounts");
    expect(names).toContain("listTransactions");
    expect(names).toContain("createOrder");
  });

  it("reads are auto-allowed, the order write is approval-gated", () => {
    const defs = openApiToHostTools(spec);
    const reads = defs.filter((d) => d.http.method === "get");
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read.annotations.readOnlyHint).toBe(true);

    const order = defs.find((d) => d.name === "createOrder")!;
    expect(order.annotations.readOnlyHint).toBe(false);
    expect(order.http).toEqual({ method: "post", path: "/api/orders", params: [], hasBody: true });
  });
});
