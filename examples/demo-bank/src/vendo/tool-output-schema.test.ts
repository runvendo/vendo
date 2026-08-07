import { promises as fs } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { GET as getSpendingInsights } from "@/app/api/insights/spending/route"

/**
 * The spending-insights tool's recorded output schema must describe what the
 * route actually returns. Live 2026-07-27: the tool carried no output schema,
 * the route answers the `{ data: [...] }` envelope, and the model bound the
 * donut's array prop to the wrapper object — three creates, no app rendered.
 * This test is the contract: schema and route agree, or the demo is lying.
 */

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Structural agreement between a JSON Schema and a REAL value: declared types
 *  hold, required fields are present, enums cover the data, and the value
 *  carries no field the schema failed to declare (drift by omission). */
function disagreements(schema: Json, value: unknown, at = "$"): string[] {
  const problems: string[] = []
  const type = schema.type
  if (type === "object") {
    if (!isRecord(value)) return [`${at}: expected an object, got ${JSON.stringify(value)}`]
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const field of Array.isArray(schema.required) ? schema.required : []) {
      if (!(String(field) in value)) problems.push(`${at}.${String(field)}: required by the schema, absent from the route`)
    }
    for (const [field, child] of Object.entries(value)) {
      const childSchema = properties[field]
      if (!isRecord(childSchema)) {
        problems.push(`${at}.${field}: returned by the route, undeclared by the schema`)
        continue
      }
      problems.push(...disagreements(childSchema, child, `${at}.${field}`))
    }
    return problems
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${at}: expected an array, got ${JSON.stringify(value)}`]
    const items = isRecord(schema.items) ? schema.items : undefined
    if (items === undefined) return problems
    value.forEach((entry, index) => problems.push(...disagreements(items, entry, `${at}[${index}]`)))
    return problems
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    problems.push(`${at}: ${JSON.stringify(value)} is outside the schema's enum`)
  }
  if (type === "integer" && !Number.isInteger(value)) problems.push(`${at}: expected an integer, got ${JSON.stringify(value)}`)
  if (type === "string" && typeof value !== "string") problems.push(`${at}: expected a string, got ${JSON.stringify(value)}`)
  if (type === "number" && typeof value !== "number") problems.push(`${at}: expected a number, got ${JSON.stringify(value)}`)
  return problems
}

const recordedOutputSchema = async (tool: string): Promise<Json | undefined> => {
  const file = await fs.readFile(path.join(process.cwd(), ".vendo", "tools.json"), "utf8")
  const tools = (JSON.parse(file) as { tools: Array<{ name: string; outputSchema?: Json }> }).tools
  return tools.find((entry) => entry.name === tool)?.outputSchema
}

describe("host_getSpendingInsights output schema", () => {
  it("matches the shape /api/insights/spending really returns", async () => {
    const schema = await recordedOutputSchema("host_getSpendingInsights")
    expect(schema, "sync must record the tool's output schema from openapi.json").toBeDefined()

    const body = await (await getSpendingInsights()).json() as unknown

    expect(disagreements(schema as Json, body)).toEqual([])
    // The failure this guards: the slices are one hop in, under `data`.
    expect(Array.isArray((body as { data?: unknown }).data)).toBe(true)
    expect((body as { data: unknown[] }).data.length).toBeGreaterThan(0)
  })
})
