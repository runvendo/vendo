import type { PermissionGrant, Principal } from "@vendoai/core";
import { actAsConformance, runConformance } from "@vendoai/core/conformance";
import { describe, expect, it } from "vitest";
import {
  auth0Preset,
  authJsPreset,
  clerkPreset,
  genericJwtPreset,
  supabasePreset,
} from "./index.js";

const principal: Principal = { kind: "user", subject: "preset-conformance-user" };
const grant: PermissionGrant = {
  id: "grt_preset_conformance",
  subject: principal.subject,
  tool: "host_conformance",
  descriptorHash: "sha256:preset-conformance",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "preset-conformance-secret-at-least-32-bytes";

describe.each([
  ["Generic JWT", genericJwtPreset({ secret })],
  ["Auth.js", authJsPreset({ secret })],
  ["Supabase Auth", supabasePreset({ secret })],
  ["Clerk away-token", clerkPreset({ secret }).actAs],
  ["Auth0 away-token", auth0Preset({ secret }).actAs],
] as const)("%s preset", (_name, actAs) => {
  it("passes the core ActAs conformance suite", async () => {
    const suite = actAsConformance({ actAs, principal, grant });
    const report = await runConformance(suite);

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(suite.cases.length);
  });
});
