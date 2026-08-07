import type { PermissionGrant, Principal } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const principal: Principal = { kind: "user", subject: "user_authjs_retry" };
const grant: PermissionGrant = {
  id: "grt_authjs_retry",
  subject: principal.subject,
  tool: "host_profile",
  descriptorHash: "sha256:authjs-retry",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-14T00:00:00.000Z",
};
const secret = "authjs-secret-for-retry-verification";
const cookieName = "authjs.session-token";

/** Simulate `@auth/core` not being installed: the dynamic import rejects the
    way Node rejects a missing package. */
function mockAuthCoreMissing(): void {
  vi.doMock("@auth/core/jwt", () => {
    const error = new Error(
      "Cannot find package '@auth/core' imported from packages/actions/src/presets/auth-js.ts",
    ) as Error & { code: string };
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  });
}

async function loadPreset(): Promise<typeof import("./auth-js.js")> {
  return await import("./auth-js.js");
}

describe("authJsPreset @auth/core loading", () => {
  afterEach(() => {
    vi.doUnmock("@auth/core/jwt");
    vi.resetModules();
  });

  it("rejects a missing @auth/core with an actionable install instruction", async () => {
    mockAuthCoreMissing();
    vi.resetModules();
    const { authJsPreset } = await loadPreset();
    const actAs = authJsPreset({ secret, cookieName });

    await expect(actAs(principal, grant)).rejects.toThrow(/npm install @auth\/core/);
  });

  it("retries the import on the SAME preset instance after @auth/core is installed", async () => {
    mockAuthCoreMissing();
    vi.resetModules();
    const { authJsPreset } = await loadPreset();
    const actAs = authJsPreset({ secret, cookieName });

    await expect(actAs(principal, grant)).rejects.toThrow(/npm install @auth\/core/);

    // "Install" the package: the real module resolves from here on.
    vi.doUnmock("@auth/core/jwt");
    vi.resetModules();

    const material = await actAs(principal, grant);
    expect(material?.headers.cookie).toMatch(/^authjs\.session-token=/);
  });
});
