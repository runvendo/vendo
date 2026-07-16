/** ENG-263 §C — KEY-GATED ORGS through the composed wire.
 *
 * All the machinery ships OSS; activation rides the console's
 * /api/v1/keys/validate (stubbed here on loopback, granting the `orgs`
 * capability). Role model over the real wire: members run, admins approve
 * and manage.
 *
 * Adversarial coverage:
 *   - without a key every org API returns the posture error (402 cloud-required),
 *   - an org MEMBER cannot approve (403 on the org approvals surfaces),
 *   - a member cannot manage (delete/transfer refused), a non-member sees nothing.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ADA, BOB, createStack, resetFixture, type Stack } from "./harness.js";

const KEY = `vnd_${"f".repeat(40)}`;

let stack: Stack;
let console_: Server | undefined;
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  await stack?.close();
  if (console_) await new Promise<void>((resolve) => console_!.close(() => resolve()));
  console_ = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A loopback Vendo-console stub serving /api/v1/keys/validate. */
async function consoleStub(capabilities: Record<string, boolean>): Promise<string> {
  console_ = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/keys/validate") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        valid: true,
        contract_version: 2,
        org: { id: "corg_1", name: "Acme", slug: "acme" },
        plan: { id: "team", name: "Team", status: "active" },
        capabilities,
        limits: {},
        cache: { ttl_seconds: 600, stale_if_error_seconds: 86400 },
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    console_!.once("error", reject);
    console_!.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = console_!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function seedApp(current: Stack, id: string, subject: string): Promise<void> {
  await current.sql(
    `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
     VALUES ($1, $2, true, $3::jsonb, now(), now())`,
    [id, subject, JSON.stringify({ format: "vendo/app@1", id, name: "Org fixture app" })],
  );
}

describe("ENG-263: key-gated orgs over the wire", () => {
  it("returns the posture error on every org API without a key", async () => {
    await resetFixture();
    setEnv("VENDO_API_KEY", undefined);
    stack = await createStack();

    const list = await stack.wireFetch("/orgs", {}, ADA);
    expect(list.status).toBe(402);
    const body = (await list.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("cloud-required");
    expect(body.error.message).toContain("VENDO_API_KEY");

    expect((await stack.wireFetch("/orgs", { method: "POST", body: JSON.stringify({ name: "Acme" }) }, ADA)).status).toBe(402);
    expect((await stack.wireFetch("/approvals?org=org_x", {}, ADA)).status).toBe(402);
    expect((await stack.wireFetch("/grants?org=org_x", {}, ADA)).status).toBe(402);
  });

  it("creates orgs, enforces the role ladder, and scopes org apps: members run, admins manage", async () => {
    await resetFixture();
    setEnv("VENDO_API_KEY", KEY);
    setEnv("VENDO_CLOUD_URL", await consoleStub({ orgs: true }));
    stack = await createStack();

    // Owner creates the org and invites Bob as MEMBER.
    const created = await stack.wireFetch("/orgs", { method: "POST", body: JSON.stringify({ name: "Acme Corp" }) }, ADA);
    expect(created.status).toBe(200);
    const org = (await created.json()) as { id: string; name: string };
    expect(org.name).toBe("Acme Corp");
    expect((await stack.wireFetch(`/orgs/${org.id}/members`, {
      method: "POST",
      body: JSON.stringify({ subject: BOB.subject, role: "member" }),
    }, ADA)).status).toBe(200);

    // Bob sees the org with his role; a stranger sees nothing.
    const bobList = (await (await stack.wireFetch("/orgs", {}, BOB)).json()) as { orgs: Array<{ id: string; role: string }> };
    expect(bobList.orgs).toEqual([expect.objectContaining({ id: org.id, role: "member" })]);
    const strangerView = await stack.wireFetch(`/orgs/${org.id}`, {}, { kind: "user", subject: "user_stranger" });
    expect(strangerView.status).toBe(404);

    // Ada transfers her app to the org — it is owned by the ORG subject now.
    await seedApp(stack, "app_org_e2e", ADA.subject);
    const transfer = await stack.wireFetch(`/orgs/${org.id}/apps`, {
      method: "POST",
      body: JSON.stringify({ appId: "app_org_e2e" }),
    }, ADA);
    expect(transfer.status).toBe(200);
    expect(await stack.sql("SELECT subject FROM vendo_apps WHERE id = 'app_org_e2e'"))
      .toEqual([{ subject: `vendo:org:${org.id}` }]);

    // Members RUN: Bob reads the org app and it shows in his /apps listing.
    expect((await stack.wireFetch("/apps/app_org_e2e", {}, BOB)).status).toBe(200);
    const bobApps = (await (await stack.wireFetch("/apps", {}, BOB)).json()) as Array<{ id: string }>;
    expect(bobApps.map((app) => app.id)).toContain("app_org_e2e");

    // Members do NOT manage: delete refuses loudly; the app survives.
    const bobDelete = await stack.wireFetch("/apps/app_org_e2e", { method: "DELETE" }, BOB);
    expect(bobDelete.status).toBe(403);
    expect(((await bobDelete.json()) as { error: { message: string } }).error.message).toContain("admin");
    expect(await stack.sql("SELECT id FROM vendo_apps WHERE id = 'app_org_e2e'")).toHaveLength(1);

    // A non-member cannot even see the app.
    expect((await stack.wireFetch("/apps/app_org_e2e", {}, { kind: "user", subject: "user_stranger" })).status).toBe(404);

    // Members cannot APPROVE: the org approvals/grants surfaces are admin-gated.
    const bobApprovals = await stack.wireFetch(`/approvals?org=${org.id}`, {}, BOB);
    expect(bobApprovals.status).toBe(403);
    const bobDecide = await stack.wireFetch("/approvals/decide", {
      method: "POST",
      body: JSON.stringify({ ids: ["apr_x"], decision: { approve: true }, org: org.id }),
    }, BOB);
    expect(bobDecide.status).toBe(403);
    expect((await stack.wireFetch(`/grants?org=${org.id}`, {}, BOB)).status).toBe(403);

    // Admins approve and manage: promote Bob, and the same surfaces open up.
    expect((await stack.wireFetch(`/orgs/${org.id}/members/${BOB.subject}`, {
      method: "PATCH",
      body: JSON.stringify({ role: "admin" }),
    }, ADA)).status).toBe(200);
    expect((await stack.wireFetch(`/approvals?org=${org.id}`, {}, BOB)).status).toBe(200);
    expect((await stack.wireFetch(`/grants?org=${org.id}`, {}, BOB)).status).toBe(200);
    const adminDelete = await stack.wireFetch("/apps/app_org_e2e", { method: "DELETE" }, BOB);
    expect(adminDelete.status).toBe(200);
    expect(await stack.sql("SELECT id FROM vendo_apps WHERE id = 'app_org_e2e'")).toEqual([]);

    // The org lifecycle is auditable (kind="principal" events).
    const audit = await stack.sql<{ event: { detail?: { event?: string } } }>(
      "SELECT event FROM vendo_audit WHERE kind = 'principal'",
    );
    const events = audit.map((row) => row.event.detail?.event);
    expect(events).toContain("org-created");
    expect(events).toContain("org-member-added");
    expect(events).toContain("org-member-role");
    expect(events).toContain("org-app-transferred");
  });

  it("posture-errors when the key's plan lacks the orgs capability", async () => {
    await resetFixture();
    setEnv("VENDO_API_KEY", KEY);
    setEnv("VENDO_CLOUD_URL", await consoleStub({ orgs: false, sharing: true }));
    stack = await createStack();

    const response = await stack.wireFetch("/orgs", {}, ADA);
    expect(response.status).toBe(402);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("capability");
  });
});
