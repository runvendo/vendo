import type { Principal, ResolvedPerson } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { auth0 } from "../../src/auth-presets/auth0.js";
import { authJs } from "../../src/auth-presets/auth-js.js";
import { clerk } from "../../src/auth-presets/clerk.js";
import { jwt } from "../../src/auth-presets/jwt.js";
import { supabase } from "../../src/auth-presets/supabase.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "../../src/auth-presets/shared.js";

/**
 * Build contract §9.1 companion (orchestrator-ratified 2026-08-01) — the FIFTH
 * seam, threaded exactly like `memberships` and for the same reason: Vendo holds
 * no directory, so only the HOST can turn "Mia" into a subject. Unset, the Share
 * dialog does not offer to share with one person at all; set, the grant is
 * written for the SUBJECT it returns and never for what was typed.
 */

/** A host directory that scopes by the ASKER — the reason the seam is given one
    (compare `memberships`, keyed on Principal for exactly this). Only staff Maple
    itself issued get answers. */
const resolvePerson = async (query: string, asker: Principal): Promise<ResolvedPerson | null> => {
  if (!asker.subject.startsWith("host_")) return null;
  return query.toLowerCase().includes("mia") ? { subject: "maple-mia", display: "Mia Nakamura" } : null;
};

const yousef: Principal = { kind: "user", subject: "host_yousef" };
const outsider: Principal = { kind: "user", subject: "someone-elses-tenant" };

const secret = "vendo-preset-resolve-person-secret-with-entropy";

const presets: Record<string, (options: HostAuthPresetOptions) => HostAuthPreset> = {
  authJs: (options) => authJs({ ...options, secret }),
  jwt: (options) => jwt({ ...options, secret }),
  supabase: (options) => supabase({ ...options, secret }),
  clerk: (options) => clerk({ ...options, secret }),
  auth0: (options) => auth0({ ...options, secret }),
};

describe("§9.1 companion — the resolvePerson auth-preset seam", () => {
  for (const [name, build] of Object.entries(presets)) {
    it(`${name}() forwards the resolvePerson callback onto the preset`, async () => {
      const preset = build({ resolvePerson });
      // Forwarded VERBATIM — the same function object. A preset that wrapped it
      // would be free to drop the second argument, which is the whole point of
      // giving the seam one; the build/typecheck tsconfig excludes test files, so
      // identity is what actually holds that line here.
      expect(preset.resolvePerson).toBe(resolvePerson);
      expect(await preset.resolvePerson?.("mia@maple.com", yousef))
        .toEqual({ subject: "maple-mia", display: "Mia Nakamura" });
      // A name the host does not know is NULL — never a guess, never the query.
      expect(await preset.resolvePerson?.("someone from another company", yousef)).toBeNull();
      // ...and the ASKER reaches the host, so scoping the directory to them is
      // implementable at all. Same name, different asker, different answer.
      expect(await preset.resolvePerson?.("mia@maple.com", outsider)).toBeNull();
    });

    it(`${name}() leaves the seam unset when the host has no directory to offer`, () => {
      expect(build({}).resolvePerson).toBeUndefined();
    });
  }
});
