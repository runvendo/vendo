import { z } from "zod";

/** The doors a run can arrive through. ONE list: the type, the schema, and the
 *  security tests that sweep every venue all derive from it, so a fifth venue
 *  cannot be added in one place and silently escape the others. THE LAW's
 *  predicate is presence, never the venue (grant-sets `isUnattended`) — the
 *  sweeps exist to keep it that way for venues nobody has thought of yet.
 *
 *  This lives in a zod-only LEAF module (no other core imports) so every schema
 *  that enumerates venues — run-context (§3), audit (§7), grants/approvals (§5)
 *  — reuses the same source without an import cycle. */
export const VENUES = ["chat", "app", "automation", "mcp", "rehearsal"] as const;
export type Venue = (typeof VENUES)[number];
export const venueSchema = z.enum(VENUES);
