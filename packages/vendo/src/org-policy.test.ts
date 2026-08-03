import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext, ToolDescriptor } from "@vendoai/core";
import { createGuard } from "@vendoai/guard";
import { createStore, workspaceStore } from "@vendoai/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgPolicyPath, orgPolicyResolver, workspacePolicySource } from "./org-policy.js";

/** Build contract §9.10, the composition half: which files get read for whom,
 *  and what a bad one does. The clamp itself is the guard's (org-policy.test.ts
 *  there); this is the seam that feeds it. */

const ctx = (memberships?: unknown): RunContext => ({
  principal: { kind: "user", subject: "user_dana" },
  venue: "chat",
  presence: "present",
  sessionId: "session_1",
  ...(memberships === undefined ? {} : { memberships }),
} as RunContext);

const policy = (rules: unknown[]): string =>
  JSON.stringify({ format: "vendo/org-policy@1", rules });

describe("org policy resolution at the composition seam", () => {
  it("reads nothing at all when the caller asserted no orgs", async () => {
    const source = vi.fn();
    expect(await orgPolicyResolver(source)(ctx())).toEqual([]);
    expect(source).not.toHaveBeenCalled();
  });

  it("unions the rules of every asserted org, once per org", async () => {
    const source = vi.fn(async (org: string) =>
      org === "maple"
        ? policy([{ match: { risk: "destructive" }, action: "block" }])
        : policy([{ match: { tool: "host_pay*" }, action: "ask" }]));

    const rules = await orgPolicyResolver(source)(ctx([
      { org: "maple", admin: true },
      { org: "cadence" },
      { org: "maple" },
    ]));

    expect(rules).toEqual([
      { match: { risk: "destructive" }, action: "block" },
      { match: { tool: "host_pay*" }, action: "ask" },
    ]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("treats an absent policy file as no rules", async () => {
    expect(await orgPolicyResolver(async () => undefined)(ctx([{ org: "maple" }]))).toEqual([]);
  });

  /** F7 — one org's broken file must not disarm every OTHER org's policy. The
   *  bad file is reported and skipped; the rest still bind. */
  it("keeps the parseable orgs' rules when one org's file is malformed, and reports the failure", async () => {
    const failures: Array<{ org: string; reason: string }> = [];
    const resolve = orgPolicyResolver(
      async (org) => org === "broken"
        ? "{not json"
        : policy([{ match: { risk: "destructive" }, action: "block" }]),
      (org, reason) => { failures.push({ org, reason }); },
    );

    const rules = await resolve(ctx([{ org: "broken" }, { org: "maple" }]));

    expect(rules).toEqual([{ match: { risk: "destructive" }, action: "block" }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.org).toBe("broken");
    expect(failures[0]?.reason).toMatch(/org broken/);
  });

  it("reports a file that tries to LOOSEN and applies none of its rules", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      async () => policy([{ match: {}, action: "run" }, { match: {}, action: "block" }]),
      (org) => { failures.push(org); },
    );

    // Not "drop the run rule and keep the block": a file this layer cannot
    // understand is not partially applied.
    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual(["maple"]);
  });

  /** F8 — an absent file and a FAILED READ are different facts. Absent is the
   *  normal case (most orgs set no policy); a read that blew up must be heard,
   *  because silently treating it as "no policy" is a silent loosening. */
  it("reports a source that fails to read, rather than treating it as no policy", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      async () => { throw new Error("workspace read failed"); },
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual(["maple: workspace read failed"]);
  });

  it("says nothing at all when the file is simply absent", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(async () => undefined, (org) => { failures.push(org); });

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("ignores a memberships field that is not a list of orgs", async () => {
    const source = vi.fn();
    expect(await orgPolicyResolver(source)(ctx("maple"))).toEqual([]);
    expect(await orgPolicyResolver(source)(ctx([{ team: "finance" }, null, 7]))).toEqual([]);
    expect(source).not.toHaveBeenCalled();
  });

  it("reads each org's file from the org's own subtree", () => {
    expect(orgPolicyPath("maple")).toBe("/orgs/maple/policy.json");
  });
});

/** N2 — the previous absent-vs-failed split was written against `error.code`,
 *  which the workspace never sets: its refusals are plain Errors carrying the
 *  code as a MESSAGE prefix (`ENOENT: no such file…`, store/workspace-fs.ts).
 *  So the ordinary case — an org with no policy.json — took the FAILURE path:
 *  a warning and an audit row on every guarded call, and the throw skipped the
 *  cache so the TTL never engaged. These tests go through the real workspace,
 *  not a stubbed source, because that is the blind spot that let it ship. */
describe("org policy over the REAL workspace", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const realStore = async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-org-policy-store-"));
    const store = createStore({ dataDir });
    cleanups.push(async () => {
      await store.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    });
    await store.ensureSchema();
    return store;
  };

  it("is SILENT for an org with no policy file — no rules, no failure reported", async () => {
    const store = await realStore();
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      workspacePolicySource(store),
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toEqual([]);
  });

  it("caches the absent answer, so the TTL engages instead of reading per call", async () => {
    const store = await realStore();
    const source = workspacePolicySource(store);

    expect(await source("maple")).toBeUndefined();
    // A closed store cannot be read at all — so a second `undefined` here can
    // only have come from the cache.
    await store.close();
    expect(await source("maple")).toBeUndefined();
  });

  /** D1 — the seam's WHOLE PURPOSE, end to end: an admin writes a rule into
   *  `/orgs/<org>/policy.json` through the real workspace, and that rule
   *  changes a guard decision for a member of that org.
   *
   *  Nothing above ever wrote a policy file, and that is exactly the blind spot
   *  it hid. The façade was opened with NO memberships, so `/orgs/<org>` had no
   *  mount, the read threw ENOENT (the workspace refuses an unmounted path with
   *  "no such file", store/workspace-fs.ts), and ENOENT read as "this org set
   *  no policy". `parseOrgPolicyFile` was unreachable in production: no org's
   *  policy was ever loaded, anywhere, and the failure was silent. */
  it("APPLIES a rule an admin actually wrote, all the way to a guard decision", async () => {
    const store = await realStore();
    const admin: Principal = { kind: "user", subject: "user_admin" };
    const fs = await workspaceStore(store).open(admin, {
      memberships: [{ org: "maple", admin: true }],
    });
    await fs.writeFile(
      orgPolicyPath("maple"),
      policy([{ match: { risk: "write" }, action: "ask" }]),
    );
    expect((await fs.commit()).status).toBe("ok");

    const failures: string[] = [];
    const guard = createGuard({
      store,
      orgPolicy: orgPolicyResolver(
        workspacePolicySource(store),
        (org, reason) => { failures.push(`${org}: ${reason}`); },
      ),
    });
    const write: ToolDescriptor = {
      name: "host_pay_invoice",
      description: "pay an invoice",
      inputSchema: { type: "object", additionalProperties: true },
      risk: "write",
    };
    const invoke = { id: "call_1", tool: write.name, args: {} };

    // The red half: the very same call from someone who asserted no org runs.
    await expect(guard.check(invoke, write, ctx() as RunContext))
      .resolves.toMatchObject({ action: "run" });

    // The green half: maple's file tightens it to an ask, credited to the org.
    await expect(guard.check(invoke, write, ctx([{ org: "maple" }]) as RunContext))
      .resolves.toMatchObject({ action: "ask", decidedBy: "org" });
    expect(failures).toEqual([]);
  });

  /** "No file" and "no mount" are DIFFERENT FACTS and only the first is
   *  silence-worthy — and the workspace reports BOTH as ENOENT, so the message
   *  alone can never tell them apart. A mount is ONE path segment (§9.7's
   *  `/orgs/<orgId>/**`), so a host-issued org id carrying a separator has no
   *  mount at all: nothing at that path could ever be read, and calling it
   *  "this org set no policy" hides an admin's rules behind an id nobody
   *  looked at. */
  it("reports an org id that is not addressable as a mount, rather than calling it silence", async () => {
    const store = await realStore();
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      workspacePolicySource(store),
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    expect(await resolve(ctx([{ org: "maple/eu" }]))).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/maple\/eu/);
  });

  /** The other fact ENOENT's siblings were covering for: `EISDIR` is not "no
   *  policy file", it is "something that is not a file is sitting where the
   *  policy file goes". An admin whose rules are unreachable for that reason
   *  must hear about it. */
  it("reports something OTHER THAN A FILE at the policy path", async () => {
    const store = await realStore();
    const admin: Principal = { kind: "user", subject: "user_admin" };
    const fs = await workspaceStore(store).open(admin, {
      memberships: [{ org: "maple", admin: true }],
    });
    await fs.writeFile(`${orgPolicyPath("maple")}/rules.json`, policy([]));
    expect((await fs.commit()).status).toBe("ok");

    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      workspacePolicySource(store),
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/EISDIR/);
  });

  it("still REPORTS a read that genuinely fails", async () => {
    const store = await realStore();
    const source = workspacePolicySource(store);
    // Warm the workspace façade on one org, then break the store underneath it:
    // an UNCACHED org now hits a workspace that exists but cannot answer, which
    // is a real failure and not an absent file.
    expect(await source("maple")).toBeUndefined();
    await store.close();
    const failures: string[] = [];
    const resolve = orgPolicyResolver(source, (org, reason) => { failures.push(`${org}: ${reason}`); });

    expect(await resolve(ctx([{ org: "cadence" }]))).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("cadence");
  });
});

/** F5 (wave-3 independent check) — the deployment org policy is SOLD for is the
 *  keyed one, and a keyed deployment with no explicit store gets the HOSTED
 *  store, which has no SQL handle for the workspace to open. That absence used
 *  to be memoized silently: every org resolved to no rules forever, with no
 *  warning, no audit row, and no way for an admin to learn their policy was
 *  never in force. */
describe("org policy in a deployment with no workspace at all", () => {
  /** The hosted store's shape as far as this seam is concerned: a VendoStore
   *  that is not a local engine handle, so `workspaceStore` cannot open it. */
  const noWorkspaceStore = () => ({ records: () => { throw new Error("unused"); } } as unknown as Parameters<typeof workspacePolicySource>[0]);

  it("reports the absence LOUDLY, exactly once per deployment", async () => {
    const failures: string[] = [];
    const resolve = orgPolicyResolver(
      workspacePolicySource(noWorkspaceStore()),
      (org, reason) => { failures.push(`${org}: ${reason}`); },
    );

    // Never a loosening: with no rules readable the pipeline's own verdict
    // stands, exactly as it does for an org that set no policy.
    expect(await resolve(ctx([{ org: "maple" }]))).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/workspace/i);

    // ...and ONCE. Not per org, not per guarded call — an admin needs to see it,
    // an operator must not be drowned in it.
    expect(await resolve(ctx([{ org: "maple" }, { org: "cadence" }]))).toEqual([]);
    expect(failures).toHaveLength(1);
  });
});
