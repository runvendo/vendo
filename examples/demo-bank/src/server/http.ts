import { NextResponse } from "next/server"

export function ok<T>(data: T) { return NextResponse.json({ data }) }
export function notFound(message = "Not found") {
  return NextResponse.json({ error: { message, code: "not_found" } }, { status: 404 })
}
export function badRequest(message: string) {
  return NextResponse.json({ error: { message, code: "bad_request" } }, { status: 400 })
}
/** Our fault, not the caller's: a transient failure the UI may retry. Distinct
    from a 200 carrying an empty answer, which reads as "this is switched off". */
export function serverError(message: string) {
  return NextResponse.json({ error: { message, code: "server_error" } }, { status: 503 })
}
