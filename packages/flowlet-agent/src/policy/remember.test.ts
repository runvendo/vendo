import { describe, it, expect, vi } from "vitest";
import type { ApprovalDecision, ApprovalPolicy, PolicyContext } from "./types";
import {
  createInMemoryDecisionStore,
  canonicalKey,
  rememberDecisions,
} from "./remember";

/** Build a minimal PolicyContext for tests. */
function ctx(
  overrides: Partial<PolicyContext> & { userId?: string; input?: unknown } = {},
): PolicyContext {
  const { userId = "u1", input = { x: 1 }, ...rest } = overrides;
  return {
    toolName: "testTool",
    input,
    descriptor: {} as PolicyContext["descriptor"],
    principal: { userId },
    ...rest,
  };
}

/** Stub policy that always returns the given decision. Tracks call count. */
function stubPolicy(
  decision: ApprovalDecision,
): ApprovalPolicy & { callCount: number } {
  const stub = {
    callCount: 0,
    evaluate(_ctx: PolicyContext): ApprovalDecision {
      stub.callCount++;
      return decision;
    },
  };
  return stub;
}

describe("createInMemoryDecisionStore", () => {
  it("returns undefined for an unknown key", async () => {
    const store = createInMemoryDecisionStore();
    expect(await store.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a decision", async () => {
    const store = createInMemoryDecisionStore();
    await store.set("key1", "approve");
    expect(await store.get("key1")).toBe("approve");
  });
});

describe("canonicalKey", () => {
  it("produces consistent output for the same context and version", () => {
    const c = ctx();
    const k1 = canonicalKey(c, "v1");
    const k2 = canonicalKey(c, "v1");
    expect(k1).toBe(k2);
  });

  it("differs when userId changes", () => {
    expect(canonicalKey(ctx({ userId: "u1" }), "v1")).not.toBe(
      canonicalKey(ctx({ userId: "u2" }), "v1"),
    );
  });

  it("differs when toolName changes", () => {
    const c1 = ctx();
    const c2 = { ...c1, toolName: "otherTool" };
    expect(canonicalKey(c1, "v1")).not.toBe(canonicalKey(c2, "v1"));
  });

  it("differs when input changes", () => {
    expect(canonicalKey(ctx({ input: { x: 1 } }), "v1")).not.toBe(
      canonicalKey(ctx({ input: { x: 2 } }), "v1"),
    );
  });

  it("differs when policyVersion changes", () => {
    const c = ctx();
    expect(canonicalKey(c, "v1")).not.toBe(canonicalKey(c, "v2"));
  });
});

describe("rememberDecisions", () => {
  it("first call with inner 'approve' returns 'approve' and records the key", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("approve");
    const policy = rememberDecisions(inner, store);
    const c = ctx();

    const result = await policy.evaluate(c);

    expect(result).toBe("approve");
    expect(inner.callCount).toBe(1);
    const key = canonicalKey(c, "v1");
    expect(await store.get(key)).toBe("approve");
  });

  it("second identical call returns 'allow' without consulting inner policy", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("approve");
    const policy = rememberDecisions(inner, store);
    const c = ctx();

    await policy.evaluate(c); // first call — consults inner, records
    const result = await policy.evaluate(c); // second call — should be suppressed

    expect(result).toBe("allow");
    expect(inner.callCount).toBe(1); // inner called only once
  });

  it("a different key (different input) still consults inner policy", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("approve");
    const policy = rememberDecisions(inner, store);

    await policy.evaluate(ctx({ input: { x: 1 } }));
    await policy.evaluate(ctx({ input: { x: 2 } })); // different input

    expect(inner.callCount).toBe(2); // both calls hit inner
  });

  it("a different key (different userId) still consults inner policy", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("approve");
    const policy = rememberDecisions(inner, store);

    await policy.evaluate(ctx({ userId: "u1" }));
    await policy.evaluate(ctx({ userId: "u2" })); // different user

    expect(inner.callCount).toBe(2);
  });

  it("inner 'deny' is returned as 'deny' and NOT recorded (repeat call still denies)", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("deny");
    const policy = rememberDecisions(inner, store);
    const c = ctx();

    const first = await policy.evaluate(c);
    const second = await policy.evaluate(c);

    expect(first).toBe("deny");
    expect(second).toBe("deny");
    // inner must have been consulted both times — the deny was never cached
    expect(inner.callCount).toBe(2);
    // store must be empty — deny is never recorded
    expect(await store.get(canonicalKey(c, "v1"))).toBeUndefined();
  });

  it("inner 'allow' is returned as 'allow' and NOT recorded", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("allow");
    const policy = rememberDecisions(inner, store);
    const c = ctx();

    const result = await policy.evaluate(c);

    expect(result).toBe("allow");
    // store must remain empty for allow
    expect(await store.get(canonicalKey(c, "v1"))).toBeUndefined();
    // repeat call still hits inner (not cached)
    await policy.evaluate(c);
    expect(inner.callCount).toBe(2);
  });

  it("defaults policyVersion to 'v1' when omitted", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("approve");
    const policy = rememberDecisions(inner, store);
    const c = ctx();

    await policy.evaluate(c);
    const key = canonicalKey(c, "v1");
    expect(await store.get(key)).toBe("approve");
  });

  it("a cached key under one policyVersion does not suppress under a different version", async () => {
    const store = createInMemoryDecisionStore();
    const inner = stubPolicy("approve");
    const policyV1 = rememberDecisions(inner, store, "v1");
    const policyV2 = rememberDecisions(inner, store, "v2");
    const c = ctx();

    await policyV1.evaluate(c); // caches under v1 key
    await policyV2.evaluate(c); // different key — should still consult inner

    expect(inner.callCount).toBe(2);
  });
});
