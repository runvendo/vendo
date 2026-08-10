/**
 * `admitAppDocument` — the one door in.
 *
 * Every app write — screen agent, box, seed fork, MCP, automations, console,
 * import — passes through this gate running the same normative validation from
 * the contract. No path can mint an invalid document, so "it's in the database"
 * means exactly one thing. Accepted consequence: seeds and tests must write
 * valid documents.
 *
 * `origin` is recorded on the refusal and NEVER changes what is checked — that
 * is the whole point of one door. {@link validateAppDocument} stays exported as
 * this gate's inner half: the console and the tests call it directly, and a
 * second definition of "is this document valid" is what this door exists to
 * prevent.
 *
 * Pure and browser-safe: no store, no model, no clock.
 */
import type { AppDocument, Finding } from "@vendoai/core";
import { validateAppDocument } from "./app-validation.js";

/** Who is writing. A label, never a switch. */
export type AdmissionOrigin =
  | "screen-agent"
  | "box"
  | "seed"
  | "mcp"
  | "automation"
  | "console"
  | "import";

export type AdmissionResult =
  | { ok: true; origin: AdmissionOrigin; document: AppDocument }
  /** `code` is the VendoError code a caller throws with — `"version"` for a
   *  format-version refusal, `"validation"` for everything else. */
  | { ok: false; origin: AdmissionOrigin; code: string; findings: readonly Finding[] };

export function admitAppDocument(
  input: { document: unknown; origin: AdmissionOrigin },
): AdmissionResult {
  const validation = validateAppDocument(input.document);
  if (!validation.ok) {
    return {
      ok: false,
      origin: input.origin,
      code: validation.error.code,
      findings: [{ severity: "block", where: "document", message: validation.error.message }],
    };
  }
  return { ok: true, origin: input.origin, document: validation.app };
}
