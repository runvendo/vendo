/**
 * The one honest-unavailability sentence, in its own module so every gate that
 * points a repair at the disclaimer path can quote it without an import cycle
 * (validate.ts re-exports it for its existing importers; stages/repair.ts
 * substitutes it for a node it cannot fix).
 */
export const DISCLAIMER_TEXT = "This part of the request isn't available on this host.";
