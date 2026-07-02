import { NextResponse } from "next/server"
import { DomainError } from "./errors"

export function ok<T>(data: T) { return NextResponse.json({ data }) }
export function notFound(message = "Not found") {
  return NextResponse.json({ error: { message, code: "not_found" } }, { status: 404 })
}
export function badRequest(message: string) {
  return NextResponse.json({ error: { message, code: "bad_request" } }, { status: 400 })
}

/** Map a thrown DomainError to its HTTP response; rethrow anything else. */
export function fromDomainError(err: unknown) {
  if (err instanceof DomainError) {
    return err.code === "not_found" ? notFound(err.message) : badRequest(err.message)
  }
  throw err
}
