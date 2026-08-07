import { NextResponse } from "next/server"

export function ok<T>(data: T) { return NextResponse.json({ data }) }

export function created<T>(data: T) { return NextResponse.json({ data }, { status: 201 }) }

export function notFound(message = "Not found") {
  return NextResponse.json({ error: { message, code: "not_found" } }, { status: 404 })
}

export function badRequest(message: string) {
  return NextResponse.json({ error: { message, code: "bad_request" } }, { status: 400 })
}

/** The state-machine rejection: the request was well-formed but not legal now. */
export function conflict(message: string) {
  return NextResponse.json({ error: { message, code: "conflict" } }, { status: 409 })
}
