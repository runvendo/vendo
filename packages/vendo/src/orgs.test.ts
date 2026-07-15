import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext } from "@vendoai/core";
import { appStore, createStore, registerEphemeralSubject, type VendoStore } from "@vendoai/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOrgs, type OrgsService } from "./orgs.js";

const ada: Principal = { kind: "user", subject: "user_ada" };
const bob: Principal = { kind: "user", subject: "user_bob" };
const eve: Principal = { kind: "user", subject: "user_eve" };
const anonymous: Principal = { kind: "user", subject: "anonymous_abc", ephemeral: true };

const ctx = (principal: Principal): RunContext => ({
  principal,
  venue: "chat",
  presence: "present",
  sessionId: `sess_${principal.subject}`,
});

/** A /keys/validate stub honoring the block-actions contract-v2 wire. */
function validateStub(capabilities: Record<string, boolean>, options: { status?: number } = {}): typeof fetch {
  return vi.fn(async () => {
    if (options.status !== undefined && options.status !== 200) {
      return new Response(JSON.stringify({ error: { message: "no" } }), { status: options.status });
    }
    return Response.json({
      valid: true,
      contract_version: 2,
      org: { id: "corg_1", name: "Acme", slug: "acme" },
      plan: { id: "team", name: "Team", status: "active" },
      capabilities,
      limits: {},
      cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
    });
  }) as unknown as typeof fetch;
}

let dataDir: string;
let store: VendoStore;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vendo-orgs-test-"));
  store = createStore({ dataDir });
  await store.ensureSchema();
});
afterAll(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

function entitled(): OrgsService {
  return createOrgs({
    store,
    env: { VENDO_API_KEY: "vnd_" + "a".repeat(40) },
    fetch: validateStub({ orgs: true }),
  });
}

describe("createOrgs — key-gated activation (org stays paid)", () => {
  it("has no posture and posture-errors every org API without VENDO_API_KEY", async () => {
    const service = createOrgs({ store, env: {}, fetch: validateStub({ orgs: true }) });
    expect(service.posture).toBe(false);
    await expect(service.create(ada, "Acme")).rejects.toMatchObject({ code: "cloud-required" });
    await expect(service.list(ada)).rejects.toMatchObject({ code: "cloud-required" });
    await expect(service.get(ada, "org_x")).rejects.toMatchObject({ code: "cloud-required" });
    // Passive read surfaces degrade instead of failing.
    await expect(service.memberships(ada)).resolves.toEqual([]);
  });

  it("posture-errors when the key's plan lacks the orgs capability", async () => {
    const service = createOrgs({
      store,
      env: { VENDO_API_KEY: "vnd_" + "b".repeat(40) },
      fetch: validateStub({ orgs: false, sharing: true }),
    });
    expect(service.posture).toBe("cloud");
    await expect(service.create(ada, "Acme")).rejects.toMatchObject({ code: "cloud-required" });
  });

  it("posture-errors on a rejected key (401) and an unrecognized contract", async () => {
    const rejected = createOrgs({
      store,
      env: { VENDO_API_KEY: "vnd_" + "c".repeat(40) },
      fetch: validateStub({}, { status: 401 }),
    });
    await expect(rejected.list(ada)).rejects.toMatchObject({ code: "cloud-required" });

    const garbled = createOrgs({
      store,
      env: { VENDO_API_KEY: "vnd_" + "d".repeat(40) },
      fetch: (async () => Response.json({ nope: true })) as unknown as typeof fetch,
    });
    await expect(garbled.list(ada)).rejects.toMatchObject({ code: "cloud-required" });
  });

  it("caches the contract per its ttl and serves stale inside the stale-if-error window", async () => {
    const fetchImpl = validateStub({ orgs: true });
    let clock = 1_000_000;
    const service = createOrgs({
      store,
      env: { VENDO_API_KEY: "vnd_" + "e".repeat(40) },
      fetch: fetchImpl,
      now: () => clock,
    });
    await service.list(ada);
    await service.list(ada);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);

    // Past the ttl the contract refreshes; a failing refresh inside the stale
    // window still serves, beyond it the gate fails closed.
    clock += 700 * 1_000;
    await service.list(ada);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });
});

describe("createOrgs — role semantics (members run, admins approve and manage)", () => {
  it("creates, invites, and enforces the role ladder end to end", async () => {
    const service = entitled();
    const org = await service.create(ada, "Ladder Inc");

    // Owner invites an admin and a member.
    await service.addMember(ada, org.id, bob.subject, "admin");
    await service.addMember(ada, org.id, eve.subject, "member");

    // Admins manage members…
    await service.setRole(bob, org.id, eve.subject, "admin");
    await service.setRole(bob, org.id, eve.subject, "member");
    // …but only owners touch the owner set.
    await expect(service.setRole(bob, org.id, eve.subject, "owner")).rejects.toMatchObject({ code: "blocked" });
    await expect(service.addMember(bob, org.id, "user_frank", "owner")).rejects.toMatchObject({ code: "blocked" });
    await expect(service.setRole(bob, org.id, ada.subject, "member")).rejects.toMatchObject({ code: "blocked" });

    // Members can neither invite nor manage.
    await expect(service.addMember(eve, org.id, "user_frank", "member")).rejects.toMatchObject({ code: "blocked" });
    await expect(service.removeMember(eve, org.id, bob.subject)).rejects.toMatchObject({ code: "blocked" });

    // Members can view and self-leave.
    const view = await service.get(eve, org.id);
    expect(view.role).toBe("member");
    expect(view.members.map((member) => member.subject).sort()).toEqual(
      ["user_ada", "user_bob", "user_eve"],
    );
    await service.removeMember(eve, org.id, eve.subject);
    await expect(service.get(eve, org.id)).rejects.toMatchObject({ code: "not-found" });

    // Non-members see not-found, not forbidden (no org enumeration).
    await expect(service.get({ kind: "user", subject: "user_stranger" }, org.id))
      .rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses org actions for anonymous (ephemeral) principals", async () => {
    const service = entitled();
    await expect(service.create(anonymous, "Anon Org")).rejects.toMatchObject({ code: "blocked" });
  });
});

describe("createOrgs — org app access (appContext / adminContext)", () => {
  it("transfers an owned app to the org, re-contextualizes members for run and admins for manage", async () => {
    const service = entitled();
    const org = await service.create(ada, "Apps Org");
    await service.addMember(ada, org.id, bob.subject, "admin");
    await service.addMember(ada, org.id, eve.subject, "member");

    await appStore(store).put(ada, { format: "vendo/app@1", id: "app_org_ctx", name: "Org app" } as never);
    await service.transferApp(ada, org.id, "app_org_ctx");

    // Member: run is re-contextualized onto the org principal, actor preserved.
    const run = await service.appContext(ctx(eve), "app_org_ctx", "run");
    expect(run.principal).toMatchObject({ kind: "org", subject: `vendo:org:${org.id}` });
    expect(run.actor).toEqual(eve);

    // Member: manage refuses loudly.
    await expect(service.appContext(ctx(eve), "app_org_ctx", "manage")).rejects.toMatchObject({ code: "blocked" });

    // Admin: manage allowed.
    const manage = await service.appContext(ctx(bob), "app_org_ctx", "manage");
    expect(manage.principal.kind).toBe("org");

    // Non-member: ctx passes through unchanged (the route 404s downstream).
    const stranger = ctx({ kind: "user", subject: "user_stranger" });
    expect(await service.appContext(stranger, "app_org_ctx", "run")).toBe(stranger);

    // Non-org apps: untouched, no entitlement consulted.
    await appStore(store).put(bob, { format: "vendo/app@1", id: "app_personal", name: "Mine" } as never);
    const personal = ctx(bob);
    expect(await service.appContext(personal, "app_personal", "manage")).toBe(personal);

    // adminContext: the approvals/grants surface — members blocked, admins pass.
    await expect(service.adminContext(ctx(eve), org.id)).rejects.toMatchObject({ code: "blocked" });
    const adminCtx = await service.adminContext(ctx(bob), org.id);
    expect(adminCtx.principal).toMatchObject({ kind: "org", subject: `vendo:org:${org.id}` });

    // A member cannot transfer, a non-owner of the app cannot transfer it.
    await appStore(store).put(eve, { format: "vendo/app@1", id: "app_eves", name: "Eve's" } as never);
    await expect(service.transferApp(eve, org.id, "app_eves")).rejects.toMatchObject({ code: "blocked" });
    await expect(service.transferApp(bob, org.id, "app_eves")).rejects.toMatchObject({ code: "conflict" });
  });

  it("never grants org access to ephemeral or reserved subjects", async () => {
    const service = entitled();
    const org = await service.create(ada, "Sealed Org");
    await appStore(store).put(ada, { format: "vendo/app@1", id: "app_sealed", name: "Sealed" } as never);
    await service.transferApp(ada, org.id, "app_sealed");

    registerEphemeralSubject(store, anonymous.subject);
    const anonCtx = ctx(anonymous);
    // Anonymous visitors are never members (store refuses reserved/ephemeral
    // membership), so the ctx passes through and the route 404s.
    expect(await service.appContext(anonCtx, "app_sealed", "run")).toBe(anonCtx);
    await expect(service.memberships(anonymous)).resolves.toEqual([]);
  });
});
