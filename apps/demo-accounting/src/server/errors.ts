// The one typed error the Cadence domain layer throws. API route handlers map
// `code` to an HTTP status: not_found -> 404, invalid_transition -> 400.
export type DomainErrorCode = "not_found" | "invalid_transition"

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
