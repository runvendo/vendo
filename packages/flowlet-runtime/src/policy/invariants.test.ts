/**
 * ENG-193 §8 invariant tests — PERMANENT. These encode the safety contract of
 * the permission system; a PR that breaks one of these is wrong by definition
 * (see docs/superpowers/specs/2026-07-02-eng193-permissions-design.md §8).
 */
import { describe, expect, it } from "vitest";
import type { Principal } from "@flowlet/core";
import { buildDescriptor, type ToolDescriptor } from "../descriptor";
import { createInMemoryGrantStore } from "../grant-store";
import { createGrantManager } from "../grant-manager";
import { InMemoryAuditLog } from "../embedded/in-memory-store";
import { hashDescriptor } from "../automations/grants";
import { createAutomationTools } from "../automations/tools";
import { AutomationRunner } from "../automations/runner";
import { InMemoryAutomationStore } from "../automations/store";
import { annotationPolicy } from "./annotation";
import { composePolicy } from "./compose";
import { grantPolicy } from "./grant-policy";
import { roleRule } from "./principal-rules";
import { dangerTier } from "./tier";
import type { PolicyContext } from "./types";

const scope: Principal = { tenantId: "t", subject: "u" };

const actDesc: ToolDescriptor = {
  name: "send_email",
  source: "caller",
  annotations: { readOnlyHint: false },
  hasExecute: true,
  kind: "function",
};
const criticalDesc: ToolDescriptor = {
  name: "transfer_money",
  source: "caller",
  annotations: { destructiveHint: true },
  hasExecute: true,
  kind: "function",
};

const ctxFor = (descriptor: ToolDescriptor, input: unknown = {}): PolicyContext => ({
  toolName: descriptor.name,
  input,
  descriptor,
  // No roles: the most restrictive default principal.
  principal: { userId: "u" },
});

/** A tool-scope (broadest possible) grant for the given descriptor. */
async function seedToolGrant(
  store: ReturnType<typeof createInMemoryGrantStore>,
  descriptor: ToolDescriptor,
  overrides: { descriptorHash?: string } = {},
): Promise<void> {
  await store.create(scope, {
    tool: descriptor.name,
    descriptorHash: overrides.descriptorHash ?? hashDescriptor(descriptor),
    scope: { kind: "tool" },
    duration: "standing",
    source: { kind: "chat" },
  });
}

describe("ENG-193 §8 permanent invariants", () => {
  it("INVARIANT §8.1: a grant for a critical tool never suppresses the chat approval", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, criticalDesc); // however it got into the store
    const policy = grantPolicy(annotationPolicy(), store, { principalScope: () => scope });
    expect(await policy.evaluate(ctxFor(criticalDesc, { amount: 5 }))).toBe("approve");
  });

  it("INVARIANT §8.2: automation-management tools are critical by descriptor", () => {
    const store = new InMemoryAutomationStore();
    const runner = new AutomationRunner({
      store,
      tools: async () => ({}),
      policy: { evaluate: () => "allow" },
    });
    const toolset = createAutomationTools({
      store,
      runner,
      principal: scope,
      registeredTools: async () => ({}),
    });
    for (const name of ["create_automation", "update_automation", "delete_automation"]) {
      const descriptor = buildDescriptor(name, toolset[name], "engine");
      expect(dangerTier(descriptor), name).toBe("critical");
    }
  });

  it("INVARIANT §8.5: a deny layer wins over a matching grant", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, actDesc);
    const policy = composePolicy(
      roleRule({ requiredRole: "admin" }),
      grantPolicy(annotationPolicy(), store, { principalScope: () => scope }),
    );
    // The principal holds no roles: deny stands despite the matching grant.
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("deny");
  });

  it("INVARIANT §8.6: a stale descriptorHash never suppresses", async () => {
    const store = createInMemoryGrantStore();
    await seedToolGrant(store, actDesc, { descriptorHash: "stale-manifest-republish" });
    const policy = grantPolicy(annotationPolicy(), store, { principalScope: () => scope });
    expect(await policy.evaluate(ctxFor(actDesc))).toBe("approve");
  });

  it("INVARIANT §8.8: the grant manager refuses to create a grant for a critical tool", async () => {
    const mgr = createGrantManager({
      store: createInMemoryGrantStore(),
      audit: new InMemoryAuditLog(),
    });
    await expect(
      mgr.create(
        scope,
        {
          tool: criticalDesc.name,
          scope: { kind: "tool" },
          duration: "standing",
          source: { kind: "chat" },
        },
        criticalDesc,
      ),
    ).rejects.toThrow(/critical/);
  });
});
