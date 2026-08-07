import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMaplePerson } from "./users";

afterEach(() => vi.unstubAllEnvs());

/**
 * Build contract §9.1 companion — Maple's OWN directory answers "who is this
 * person I typed into the Share dialog?". Vendo holds no directory (the host's
 * identity system IS the org), so without this the dialog does not offer to
 * share with one person at all — and it certainly never encodes what was typed
 * as a subject, which is what wrote grants that matched nobody.
 */
describe("Maple's person lookup", () => {
  it("answers a work email, a full name, and a first name with the same subject", () => {
    for (const query of ["mia@maple.com", "MIA@Maple.com", "Mia Nakamura", "mia", " Mia "]) {
      expect(resolveMaplePerson(query)).toEqual({
        subject: "maple-mia",
        display: "Mia Nakamura",
        email: "mia@maple.com",
      });
    }
  });

  it("answers null for anyone Maple never issued, and for nothing at all", () => {
    for (const query of ["", "   ", "mia@gmail.com", "Mia from the other bank", "maple-mi"]) {
      expect(resolveMaplePerson(query)).toBeNull();
    }
  });

  it("answers from the seeded IDENTITIES, so it works with password login unconfigured", () => {
    // A deployed demo signs people in through DEMO_AUTOLOGIN and sets no
    // password env at all; who EXISTS must not depend on that (users.ts's own
    // seededIdentities/seededUsers split).
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAPLE_DEMO_PASSWORD", "");
    expect(resolveMaplePerson("mia@maple.com")?.subject).toBe("maple-mia");
  });
});
