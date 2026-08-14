import { NextResponse } from "next/server"
import { DomainError } from "./errors"

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

/**
 * The one place routes turn a domain rejection into a response. Every message
 * the domain throws is written to be read aloud to a customer, so it goes back
 * verbatim; anything that isn't a DomainError is a real bug and rethrows into a
 * 500 rather than being flattened into a polite 400.
 */
export function fail(err: unknown) {
  if (err instanceof DomainError) {
    if (err.kind === "not_found") return notFound(err.message)
    if (err.kind === "conflict") return conflict(err.message)
    return badRequest(err.message)
  }
  throw err
}
