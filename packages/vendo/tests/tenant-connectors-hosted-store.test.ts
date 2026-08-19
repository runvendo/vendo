import { createActions } from "@vendoai/actions";
import { tenantConnectorSecret, type Principal, type RunContext } from "@vendoai/core";
import { hostedStore, hostedStoreOps } from "@vendoai/store";
import { fakeConsole } from "@vendoai/store/test-util";
import { describe, expect, it } from "vitest";
import { createTenantConnectors } from "../src/tenant-connectors.js";

/**
 * The tenant registrations against the HOSTED door — the seam that actually
 * ships.
 *
 * WHY THIS FILE EXISTS: `tenant-connectors.seam.test.ts` composes a local store,
 * and a local store has no engine allowlist in front of it. The hosted door does
 * (`engine-collections.ts`), and a Cloud host leaves the store slot unset, so
 * hosted is the posture the feature runs in. `vendo_tenant_connectors` shipped
 * missing from that list: the suite was green, and the first registration on a
 * live deployment answered
 *   403 collection "vendo_tenant_connectors" is not an engine collection
 * which made register, list, test and every tenant's tools dead on arrival —
 * the same miss the channel's three collections shipped with (#1276).
 *
 * So these cases drive `createTenantConnectors` through `hostedStore` and
 * `hostedStoreOps`, whose fake console serves the same gate the live door serves
 * — deliberately, per the note at `hosted-store.test-util.ts`: a fake that
 * answers a collection the real door refuses lets a wrong call pass every test
 * and fail in production. Drop `vendo_tenant_connectors` from
 * `ENGINE_COLLECTION_REGISTRY` and this file goes red.
 */

const ADA: Principal = { kind: "user", subject: "user_ada" };

const runAs = (...orgs: string[]): RunContext => ({
  principal: ADA,
  venue: "chat",
  presence: "present",
  sessionId: `s_${orgs.join("|")}`,
  memberships: orgs.map((org) => ({ org })),
});

/** The spec a tenant pastes. Parsed locally by `openApiConnector`, so the only
 *  thing on the wire here is the store — which is the point of the file. */
const LEDGER_SPEC = {
  openapi: "3.1.0",
  info: { title: "Acme Ledger", version: "1.0.0" },
  servers: [{ url: "https://ledger.acme.test" }],
  paths: {
    "/accounts/{id}": {
      get: {
        operationId: "getAccount",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {},
      },
    },
  },
};

const REGISTRATION = {
  org: "acme",
  name: "ledger",
  kind: "openapi",
  url: "https://ledger.acme.test",
  spec: LEDGER_SPEC,
} as const;

/** The whole seam over ONE fake console: the adapter the rows go through, the
 *  op surface the token is vaulted through, and the same registry binding
 *  compose-actions gives a tenant. */
const tenants = (mount = fakeConsole()) => {
  const options = {
    apiKey: "vnd_secret",
    baseUrl: "https://cloud.test",
    fetch: mount.handler as unknown as typeof fetch,
  };
  return createTenantConnectors({
    store: hostedStore(options),
    ops: hostedStoreOps(options),
    bind: (connectors) => createActions({ connectors }),
  });
};

/** What a run asserting these orgs is really offered by the overlay. */
const overlayTools = async (
  connectors: ReturnType<typeof tenants>,
  ...orgs: string[]
): Promise<string[]> => {
  const registries = await connectors.overlay(runAs(...orgs));
  const names: string[] = [];
  for (const registry of registries) {
    for (const descriptor of await registry.descriptors(runAs(...orgs))) names.push(descriptor.name);
  }
  return names;
};

describe("tenant connectors on a Cloud-hosted store", () => {
  it("registers, lists, tests and removes through the engine door", async () => {
    const connectors = tenants();

    const registered = await connectors.api.register({ ...REGISTRATION, token: "tok_acme_live" });
    expect(registered.status).toBe("ok");
    if (registered.status !== "ok") return;
    expect(registered.tools.map((tool) => tool.name)).toEqual(["openapi_ledger_getAccount"]);

    // Read back through the door a later turn uses.
    expect(await connectors.api.list("acme")).toMatchObject([
      { org: "acme", name: "ledger", kind: "openapi", url: REGISTRATION.url },
    ]);
    expect(await connectors.api.test("acme", "ledger")).toMatchObject({ status: "ok" });

    await connectors.api.remove("acme", "ledger");
    expect(await connectors.api.list("acme")).toEqual([]);
    expect(await connectors.api.test("acme", "ledger")).toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
  });

  it("grows the registering org's overlay, and ONLY that org's", async () => {
    const connectors = tenants();
    await connectors.api.register(REGISTRATION);

    expect(await overlayTools(connectors, "acme")).toContain("openapi_ledger_getAccount");
    expect(await overlayTools(connectors, "globex")).toEqual([]);
  });

  it("writes the row to the engine collection and keeps the token off it", async () => {
    const mount = fakeConsole();
    const connectors = tenants(mount);

    // The door ACCEPTED it — recording the requests alone would pass just as
    // well on a refusal, since `register` answers a refusal instead of throwing.
    expect(await connectors.api.register({ ...REGISTRATION, token: "tok_acme_live" }))
      .toMatchObject({ status: "ok" });

    // The rows really crossed the gated engine door under the name the registry
    // has to carry — not some other collection the fake would have waved through.
    const collections = mount.requests
      .map((request) => (request.json as { collection?: string } | undefined)?.collection)
      .filter((collection): collection is string => collection !== undefined);
    expect(collections).toContain("vendo_tenant_connectors");
    expect(new Set(collections)).toEqual(new Set(["vendo_tenant_connectors"]));

    // …and the credential travelled the secrets door, never a row.
    const rowBodies = mount.requests.filter(
      (request) => (request.json as { collection?: string } | undefined)?.collection !== undefined,
    );
    expect(JSON.stringify(rowBodies)).not.toContain("tok_acme_live");
    expect(await hostedStoreOps({
      apiKey: "vnd_secret",
      baseUrl: "https://cloud.test",
      fetch: mount.handler as unknown as typeof fetch,
    }).secrets.get(tenantConnectorSecret("acme", "ledger"))).toBe("tok_acme_live");
  });
});
