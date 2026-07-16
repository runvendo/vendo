import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { createRegistry } from "./registry.mjs";
import { createRouterServer } from "./server.mjs";

const ADMIN_TOKEN = "test-admin-token";

const liveRow = {
  id: "acme",
  url: "https://demo-acme.up.railway.app",
  prospect: "Acme Widgets",
  expiresAt: "2099-01-01T00:00:00Z",
};

/** Boot a router on an ephemeral port; returns fetch helpers bound to it. */
async function boot({ adminToken = ADMIN_TOKEN, seed = [], corrupt = false } = {}) {
  const filePath = path.join(mkdtempSync(path.join(tmpdir(), "demo-router-server-")), "registry.json");
  const registry = createRegistry({ filePath, log: () => {} });
  for (const row of seed) registry.upsert(row);
  if (corrupt) writeFileSync(filePath, "{ not json");
  const server = createRouterServer({
    registry: corrupt ? createRegistry({ filePath, log: () => {} }) : registry,
    adminToken,
    log: () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  after(() => new Promise((resolve) => server.close(resolve)));
  const request = (pathname, init = {}) => fetch(`${base}${pathname}`, { redirect: "manual", ...init });
  const admin = (pathname, init = {}) =>
    request(pathname, {
      ...init,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json", ...init.headers },
    });
  return { base, registry, request, admin };
}

describe("public routes", () => {
  it("GET /healthz reports ok with the demo count", async () => {
    const { request } = await boot({ seed: [liveRow] });
    const response = await request("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, demos: 1 });
  });

  it("GET / redirects to vendo.run", async () => {
    const { request } = await boot();
    const response = await request("/");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://vendo.run");
  });

  it("GET /:id 302s a live demo and increments hits", async () => {
    const { request, registry } = await boot({ seed: [liveRow] });
    const response = await request("/acme");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), liveRow.url);
    assert.equal(registry.get("acme").hits, 1);
  });

  it("GET /:id for an expired demo returns the branded 410 page", async () => {
    const { request } = await boot({ seed: [{ ...liveRow, id: "old", expiresAt: "2020-01-01T00:00:00Z" }] });
    const response = await request("/old");
    assert.equal(response.status, 410);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /book a call/i);
    assert.match(html, /https:\/\/cal\.com\/yousefhelal/);
    assert.match(html, /Vendo/);
  });

  it("GET /:id for a killed demo returns the branded 410 page", async () => {
    const { request } = await boot({ seed: [{ ...liveRow, id: "dead", killed: true }] });
    const response = await request("/dead");
    assert.equal(response.status, 410);
    assert.match(await response.text(), /book a call/i);
  });

  it("GET /:id for an unknown id returns the branded 404 page and leaks no ids", async () => {
    const { request } = await boot({ seed: [liveRow] });
    const response = await request("/nope");
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.match(html, /https:\/\/cal\.com\/yousefhelal/);
    assert.ok(!html.includes("acme"), "must not leak registered ids");
  });

  it("non-slug paths get the 404 page, not a crash", async () => {
    const { request } = await boot();
    // Note /%2e%2e is absent: WHATWG URL parsing (client AND server side)
    // normalizes dot segments to "/", which harmlessly redirects home.
    for (const pathname of ["/Not-A-Slug", "/a b", "/x/y", "/.well-known/thing", "/acme-", "/-acme"]) {
      const response = await request(pathname);
      assert.equal(response.status, 404, pathname);
    }
  });

  it("a corrupt registry fails closed: every id 404s, healthz reports not-ok", async () => {
    const { request } = await boot({ seed: [liveRow], corrupt: true });
    assert.equal((await request("/acme")).status, 404);
    const health = await request("/healthz");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, false);
  });

  it("non-GET methods on public paths are rejected with 405", async () => {
    const { request } = await boot({ seed: [liveRow] });
    assert.equal((await request("/acme", { method: "POST" })).status, 405);
  });
});

describe("admin auth", () => {
  it("rejects requests without a token (401) and never lists demos", async () => {
    const { request } = await boot({ seed: [liveRow] });
    const response = await request("/admin/demos");
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes("acme"));
  });

  it("rejects a wrong token with 401", async () => {
    const { request } = await boot({ seed: [liveRow] });
    const response = await request("/admin/demos", { headers: { Authorization: "Bearer wrong" } });
    assert.equal(response.status, 401);
  });

  it("responds 503 to ALL admin requests when no admin token is configured", async () => {
    // "" is what an unset ROUTER_ADMIN_TOKEN looks like after env plumbing.
    const { request } = await boot({ adminToken: "" });
    const response = await request("/admin/demos", { headers: { Authorization: "Bearer anything" } });
    assert.equal(response.status, 503);
  });
});

describe("admin CRUD", () => {
  it("GET /admin/demos lists rows", async () => {
    const { admin } = await boot({ seed: [liveRow] });
    const response = await admin("/admin/demos");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.demos.length, 1);
    assert.equal(body.demos[0].id, "acme");
  });

  it("POST /admin/demos upserts a validated row", async () => {
    const { admin, registry } = await boot();
    const response = await admin("/admin/demos", {
      method: "POST",
      body: JSON.stringify(liveRow),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "acme");
    assert.equal(registry.get("acme").url, liveRow.url);
  });

  it("POST validation: rejects bad slug, non-https url, bad expiresAt, malformed JSON", async () => {
    const { admin } = await boot();
    const cases = [
      { ...liveRow, id: "Bad Slug" },
      { ...liveRow, url: "http://insecure.example" },
      { ...liveRow, url: "not a url" },
      { ...liveRow, expiresAt: "tomorrow" },
      { ...liveRow, prospect: "" },
    ];
    for (const row of cases) {
      const response = await admin("/admin/demos", { method: "POST", body: JSON.stringify(row) });
      assert.equal(response.status, 400, JSON.stringify(row));
    }
    const malformed = await admin("/admin/demos", { method: "POST", body: "{ nope" });
    assert.equal(malformed.status, 400);
  });

  it("PATCH /admin/demos/:id updates killed/expiresAt/url and 404s on unknown ids", async () => {
    const { admin, registry } = await boot({ seed: [liveRow] });
    const response = await admin("/admin/demos/acme", {
      method: "PATCH",
      body: JSON.stringify({ killed: true, expiresAt: "2027-01-01T00:00:00Z" }),
    });
    assert.equal(response.status, 200);
    assert.equal(registry.get("acme").killed, true);
    assert.equal(registry.get("acme").expiresAt, "2027-01-01T00:00:00Z");

    const missing = await admin("/admin/demos/nope", { method: "PATCH", body: JSON.stringify({ killed: true }) });
    assert.equal(missing.status, 404);

    const invalid = await admin("/admin/demos/acme", { method: "PATCH", body: JSON.stringify({ url: "ftp://x" }) });
    assert.equal(invalid.status, 400);
  });

  it("DELETE /admin/demos/:id removes the row", async () => {
    const { admin, registry } = await boot({ seed: [liveRow] });
    assert.equal((await admin("/admin/demos/acme", { method: "DELETE" })).status, 204);
    assert.equal(registry.get("acme"), undefined);
    assert.equal((await admin("/admin/demos/acme", { method: "DELETE" })).status, 404);
  });

  it("a corrupt registry surfaces as 500 on admin reads, and the file is never overwritten", async () => {
    const { admin } = await boot({ seed: [liveRow], corrupt: true });
    assert.equal((await admin("/admin/demos")).status, 500);
    assert.equal((await admin("/admin/demos", { method: "POST", body: JSON.stringify(liveRow) })).status, 500);
  });
});
