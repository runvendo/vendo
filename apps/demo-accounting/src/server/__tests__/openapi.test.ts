/**
 * Keeps Cadence's OpenAPI spec honest: every documented operation must have a
 * real route handler, and every route handler must be documented. The spec is
 * the host contract Vendo's agent tools are derived from (ENG-202).
 */
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import spec from "../../../openapi.json"

const APP_DIR = join(__dirname, "..", "..", "app")

/** `/api/clients/{id}/documents` -> `src/app/api/clients/[id]/documents/route.ts` */
function routeFileFor(path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map(s => s.replace(/^\{(.+)\}$/, "[$1]"))
  return join(APP_DIR, ...segments, "route.ts")
}

/** Every route.ts under src/app/api, as an OpenAPI-style path string.
 *  `/api/vendo/**` is excluded on purpose: those are Vendo's OWN plumbing
 *  (chat stream, stage actions, scheduler tick), not part of the host API
 *  contract the agent's tools are derived from — documenting them would hand
 *  the agent its own transport as tools (the ENG-197 fidelity report flags
 *  exactly this failure mode). */
function apiRoutePaths(): string[] {
  return readdirSync(join(APP_DIR, "api"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === "route.ts")
    .map(entry => {
      const dir = relative(APP_DIR, entry.parentPath)
      const segments = dir.split(sep).map(s => s.replace(/^\[(.+)\]$/, "{$1}"))
      return `/${segments.join("/")}`
    })
    .filter(path => !path.startsWith("/api/vendo/"))
    .sort()
}

describe("openapi.json <-> route handlers", () => {
  const paths = Object.entries(spec.paths as Record<string, Record<string, unknown>>)

  it("documents exactly the routes that exist", () => {
    const documented = paths.map(([path]) => path).sort()
    expect(documented).toEqual(apiRoutePaths())
  })

  it.each(paths)("path %s has a handler for each documented method", (path, item) => {
    const file = routeFileFor(path)
    expect(existsSync(file), `missing route file: ${file}`).toBe(true)
    const source = readFileSync(file, "utf8")
    for (const method of Object.keys(item)) {
      expect(source).toMatch(new RegExp(`export async function ${method.toUpperCase()}\\b`))
    }
  })

  it("gives every operation a unique operationId", () => {
    const ids = paths.flatMap(([, item]) =>
      Object.values(item).map(op => (op as { operationId: string }).operationId),
    )
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
