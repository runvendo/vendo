import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * A tool's description is CONSUMER COPY: it is the sentence Vendo's consent
 * card shows the person being asked to approve the call (spec §16 law 3).
 *
 * Live 2026-08-03: Maple shipped seven of them as the route scanner's own
 * fallback — "POST /api/demo/pin" and friends — because nothing
 * authored a real one. The SDK now drops a description that reads like a
 * developer string, so the leak is closed at the card; this test is the other
 * half, so the demo stops producing them. The authored layer
 * (`.vendo/overrides.json`) is where a human writes the sentence; `tools.json`
 * is machine-owned and is rewritten by every `vendo sync`.
 *
 * The fallback is recognized from each tool's OWN binding rather than a
 * vocabulary of its own: the scanner writes `<METHOD> <path>`, so a description
 * that opens with the tool's HTTP method is, by construction, the machine's.
 */

interface Binding {
  kind: string
  method?: string
}

interface Tool {
  name: string
  description?: string
  binding: Binding
}

const vendoDir = path.join(process.cwd(), ".vendo")

const readJson = async <T,>(file: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.join(vendoDir, file), "utf8")) as T

describe("every Maple tool carries a description written for people", () => {
  it("ships no route-scanner fallback description on any tool", async () => {
    const { tools } = await readJson<{ tools: Tool[] }>("tools.json")
    const overrides = await readJson<{ tools: Record<string, { description?: string }> }>("overrides.json")
    const machineVoiced = tools
      .map(tool => ({
        name: tool.name,
        method: tool.binding.method,
        description: overrides.tools[tool.name]?.description ?? tool.description ?? "",
      }))
      .filter(tool => tool.method !== undefined && tool.description.startsWith(`${tool.method} `))
      .map(tool => `${tool.name}: ${tool.description}`)
    expect(machineVoiced).toEqual([])
  })
})
