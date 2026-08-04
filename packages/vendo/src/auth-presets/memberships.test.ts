import { genericJwtPreset } from "@vendoai/actions/presets";
import type { Membership, PermissionGrant, Principal } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { hostAuthPresetConformance } from "./index.js";
import { auth0 } from "./auth0.js";
import { authJs } from "./auth-js.js";
import { clerk } from "./clerk.js";
import { jwt } from "./jwt.js";
import { supabase } from "./supabase.js";
import type { HostAuthPreset, HostAuthPresetOptions } from "./shared.js";

/** Build contract §9.1 — the FOURTH seam. Keyed on Principal, not Request:
    that is what makes it callable for unattended runs (a fire-time sponsor
    check has no session), and it is why every preset must forward it. */

const memberships = async (principal: Principal): Promise<Membership[]> =>
  principal.subject === "host_yousef" ? [{ org: "maple", admin: true }] : [];

const secret = "vendo-preset-memberships-secret-with-entropy";

const presets: Record<string, (options: HostAuthPresetOptions) => HostAuthPreset> = {
  authJs: (options) => authJs({ ...options, secret }),
  jwt: (options) => jwt({ ...options, secret }),
  supabase: (options) => supabase({ ...options, secret }),
  clerk: (options) => clerk({ ...options, secret }),
  auth0: (options) => auth0({ ...options, secret }),
};

describe("contract §9.1 — the memberships auth-preset seam", () => {
  for (const [name, build] of Object.entries(presets)) {
    it(`${name}() forwards the memberships callback onto the preset`, async () => {
      const preset = build({ memberships });
      expect(preset.memberships).toBeDefined();
      expect(await preset.memberships?.({ kind: "user", subject: "host_yousef" }))
        .toEqual([{ org: "maple", admin: true }]);
      expect(await preset.memberships?.({ kind: "user", subject: "stranger" })).toEqual([]);
    });

    it(`${name}() leaves the seam unset when the host asserts nothing`, () => {
      expect(build({}).memberships).toBeUndefined();
    });
  }
});

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_memberships_conformance",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:memberships-conformance",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

describe("the conformance kit covers the fourth seam", () => {
  const suite = hostAuthPresetConformance({
    preset: jwt({ secret, memberships, user: (subject) => (subject === "host_yousef" ? {} : null) }),
    async sessionRequest(subject) {
      const material = await genericJwtPreset({ secret })({ kind: "user", subject }, grantFor(subject));
      return new Request("https://host.test/api/vendo/threads", { headers: material!.headers });
    },
    knownSubject: "host_yousef",
    unknownSubject: "intruder",
    expectedMemberships: [{ org: "maple", admin: true }],
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});
