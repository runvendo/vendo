/**
 * Keeps Cadence's OpenAPI spec honest: every documented operation must have a
 * real route handler, and every route handler must be documented. The spec is
 * the host contract Vendo's agent tools are derived from (ENG-202).
 */
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import spec from "../../../openapi.json"
import tools from "../../../.vendo/tools.json"
import { BASE_PATH } from "@/lib/base-path"

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
 *  (chat stream, stage actions, consent, and trust), not part of the host API
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

  /**
   * THE MOUNT POINT HAS TO REACH THE AGENT'S TOOL CALLS.
   *
   * Cadence is served in place at demos.vendo.run/cadence, so the endpoints
   * really live at `<origin>/cadence/api/…`. Next rewrites the app's own
   * requests; it does not know the agent exists. The prefix travels
   * `openapi.json` servers → `vendo sync` → `.vendo/tools.json` `binding.path`,
   * and NOTHING a human can see depends on it: get it wrong and every page
   * renders perfectly while every number the agent quotes is a 404. That is why
   * this is asserted rather than eyeballed.
   */
  it("declares the mount point as its server", () => {
    expect(spec.servers).toEqual([{ url: BASE_PATH }])
  })

  it("carries the mount point into every synced tool binding", () => {
    const bindings = tools.tools.map(tool => tool.binding)
    expect(bindings.length).toBeGreaterThan(0)
    for (const binding of bindings) {
      expect(binding.path.startsWith(`${BASE_PATH}/`), `${binding.method} ${binding.path}`).toBe(true)
    }
  })

  /** Also catches a STALE tools.json — a spec edit that never got synced. */
  it("synced one tool binding per documented operation", () => {
    const documented = paths.flatMap(([path, item]) =>
      Object.keys(item).map(method => `${method.toUpperCase()} ${BASE_PATH}${path}`),
    )
    const synced = tools.tools.map(tool => `${tool.binding.method} ${tool.binding.path}`)
    expect(synced.sort()).toEqual(documented.sort())
  })

  it("gives every operation a unique operationId", () => {
    const ids = paths.flatMap(([, item]) =>
      Object.values(item).map(op => (op as { operationId: string }).operationId),
    )
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
