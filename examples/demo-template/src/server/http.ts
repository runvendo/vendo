import { NextResponse } from "next/server"

export function ok<T>(data: T) { return NextResponse.json({ data }) }
export function notFound(message = "Not found") {
  return NextResponse.json({ error: { message, code: "not_found" } }, { status: 404 })
}
export function badRequest(message: string) {
  return NextResponse.json({ error: { message, code: "bad_request" } }, { status: 400 })
}
