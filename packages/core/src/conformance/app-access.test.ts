import { describe, expect, it } from "vitest";
import type { AppAccess, AppId } from "../index.js";
import { appAccessConformance, memoryAppAccess, runConformance } from "./index.js";

/**
 * The `can()` conformance kit, mounted against core's own reference the same way
 * the KnowledgeAdapter kit is (conformance/knowledge.test.ts). @vendoai/store and
 * @vendoai/apps each mount this kit too, over real rows — this suite proves the
 * KIT itself, so a case that cannot be satisfied by any implementation is caught
 * here rather than showing up as a mystery failure in two other packages.
 */
describe("AppAccess conformance kit against the memory reference", () => {
  const suite = appAccessConformance(memoryAppAccess());

  it("mounts the whole seam", () => {
    expect(suite.seam).toBe("app-access (build contract §9.2–§9.4)");
    expect(suite.cases.length).toBeGreaterThanOrEqual(18);
  });

  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }

  it("runConformance reports ok for the reference", async () => {
    const report = await runConformance(appAccessConformance(memoryAppAccess()));
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("the kit is not vacuous: a can() that always says yes fails it", async () => {
    // The reason the kit exists at all — before it, mutating the real `can()` to
    // `return true` left both implementations' own suites entirely green.
    const reference = memoryAppAccess();
    const alwaysYes: AppAccess = { ...reference.access, async can() { return true; } };
    const report = await runConformance(appAccessConformance({ ...reference, access: alwaysYes }));
    expect(report.ok).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
  });

  it("the kit catches an implementation that skips the owner gate on grant", async () => {
    const reference = memoryAppAccess();
    const ungated: AppAccess = {
      ...reference.access,
      async grant(ctx, appId: AppId, principal, level) {
        await reference.seedGrant(appId, principal, level);
      },
    };
    const report = await runConformance(appAccessConformance({ ...reference, access: ungated }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name).join("\n")).toContain("owner-gated");
  });

  it("the kit catches an implementation that ignores asserted memberships", async () => {
    const reference = memoryAppAccess();
    const noMemberships: AppAccess = {
      ...reference.access,
      async levelFor(ctx, appId) {
        // Drops org/team grants: only the row subject and direct user grants.
        return reference.access.levelFor({ ...ctx, memberships: [] }, appId);
      },
    };
    const report = await runConformance(appAccessConformance({ ...reference, access: noMemberships }));
    expect(report.ok).toBe(false);
  });
});
