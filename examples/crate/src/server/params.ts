/**
 * Reads request arguments from the query string and, on writes, a JSON body —
 * merged, body winning. Accepting both is deliberate: `vendo init` binds tools
 * to routes with an `argsIn` of query or body, and a route that only speaks one
 * of them fails the moment that guess is wrong.
 */
export interface Params {
  get(name: string): string | undefined
  /** Missing stays missing; junk becomes NaN so the domain rejects it by name. */
  num(name: string): number | undefined
  bool(name: string): boolean
}

export async function readParams(req: Request): Promise<Params> {
  const merged: Record<string, string> = {}

  for (const [key, value] of new URL(req.url).searchParams) merged[key] = value

  if (req.method !== "GET" && req.method !== "HEAD") {
    try {
      const text = await req.text()
      if (text.trim()) {
        const body = JSON.parse(text)
        if (body && typeof body === "object" && !Array.isArray(body)) {
          for (const [key, value] of Object.entries(body)) {
            if (value !== null && value !== undefined) merged[key] = String(value)
          }
        }
      }
    } catch {
      // Not JSON. The query string still stands, and validation downstream will
      // say what is missing.
    }
  }

  return {
    get(name) {
      const raw = merged[name]
      return raw !== undefined && raw.trim() !== "" ? raw : undefined
    },
    num(name) {
      const raw = merged[name]
      if (raw === undefined || raw.trim() === "") return undefined
      return Number(raw)
    },
    bool(name) {
      const raw = merged[name]?.trim().toLowerCase()
      return raw === "true" || raw === "1" || raw === "yes"
    },
  }
}
