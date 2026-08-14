/**
 * Caller-facing rejections. The domain throws these when the *request* is wrong
 * — unknown order, illegal transition, over-refund — and the route maps them to
 * a clean 4xx the agent can read back to a human. Anything else that escapes is
 * a real bug and should surface as a 500.
 */
export type DomainErrorKind = "not_found" | "bad_request" | "conflict"

export class DomainError extends Error {
  readonly kind: DomainErrorKind

  constructor(kind: DomainErrorKind, message: string) {
    super(message)
    this.name = "DomainError"
    this.kind = kind
  }
}

export const notFoundError = (message: string) => new DomainError("not_found", message)
export const badRequestError = (message: string) => new DomainError("bad_request", message)
export const conflictError = (message: string) => new DomainError("conflict", message)
