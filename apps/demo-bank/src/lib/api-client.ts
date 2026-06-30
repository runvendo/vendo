async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error?.message ?? "Request failed")
  return body.data as T
}
export const api = { get }
