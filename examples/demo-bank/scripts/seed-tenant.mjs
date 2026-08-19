#!/usr/bin/env node
/**
 * Seeds Maple's demo tenant over the PUBLIC API — the same four calls a
 * customer would make:
 *
 *   pnpm seed:tenant          # needs VENDO_API_KEY_ADMIN (an admin-scoped key)
 *
 * Tenant writes take an admin-scoped key on purpose: a runtime key ships inside
 * every deployment of the product, and rearranging who is in which company from
 * it is the same class of power the admin scope already fences.
 */
const base = (process.env.VENDO_CLOUD_URL ?? "https://console.vendo.run").replace(/\/+$/, "");
const adminKey = process.env.VENDO_API_KEY_ADMIN;
const runtimeKey = process.env.VENDO_API_KEY;
if (!adminKey) throw new Error("seed:tenant needs VENDO_API_KEY_ADMIN (an admin-scoped Vendo Cloud key)");
if (!runtimeKey) throw new Error("seed:tenant needs VENDO_API_KEY (the runtime key identify rides)");

const call = async (path, { method = "GET", key = adminKey, body } = {}) => {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? undefined : await response.json().catch(() => undefined);
};

const PEOPLE = [
  { externalId: "alice@maple.com", name: "Alice Chen" },
  { externalId: "bob@maple.com", name: "Bob Ruiz" },
];

// 1. The tenant. 409 means a previous run already made it — the seed is
//    re-runnable, which is the only way a demo script is ever used.
await call("/tenants", { method: "POST", body: { id: "acme", name: "Acme Corp" } });

// 2. Identify each person on the RUNTIME key, exactly as Maple's server does.
for (const person of PEOPLE) {
  await call(`/users/${encodeURIComponent(person.externalId)}`, {
    method: "PUT",
    key: runtimeKey,
    body: { traits: { name: person.name, email: person.externalId }, tenant: "acme" },
  });
}

// 3. Alice runs the company.
await call(`/tenants/acme/members/${encodeURIComponent(PEOPLE[0].externalId)}`, {
  method: "PUT",
  body: { role: "admin" },
});

// 4. A cap the demo can actually reach.
await call("/tenants/acme", {
  method: "PATCH",
  body: { limits: { generationsPerMonth: { limit: 20, scope: "per-tenant" } } },
});

const tenant = await call("/tenants/acme");
console.log(`Acme Corp: ${tenant.members.length} members, generations/month = ${tenant.limits.generationsPerMonth.limit} (per tenant)`);
for (const member of tenant.members) console.log(`  ${member.externalId} — ${member.role}`);
