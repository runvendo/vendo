import { withBasePath } from "./base-path"

/** `path` is the bare API path (`/api/accounts`), which is also its SWR key —
 *  so keys and `mutate()` calls stay written in the API's own vocabulary. The
 *  mount point is added here, at the one place the request is actually made. */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(withBasePath(path))
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error?.message ?? "Request failed")
  return body.data as T
}
export const api = { get }
