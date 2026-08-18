/**
 * Tenant connectors — one org's own MCP server or OpenAPI spec, registered at
 * runtime by the host's own dev-side code. No redeploy, no console, no UI.
 *
 * Isolation is STRUCTURAL, not a filter. Each org that has registered anything
 * gets its OWN actions registry, built over the shared connectors PLUS its own;
 * a request is served the registry its ASSERTED memberships select (build
 * contract §9.1 — the same `memberships` the org-policy seam reads). Another
 * tenant's connector is not withheld from that registry, it was never in it, so
 * there is no filter to get wrong and no listing that could leak a name.
 *
 * Nothing here is a store schema change. The registrations live in the generic
 * `vendo_records` collection — `vendo_tenant_connectors` is neither reserved nor
 * dedicated (store/routing.ts), so it routes to `vendo_records` on every adapter
 * with no migration — ref'd `{ subject: org }`, which is the key the erase
 * cascade already matches (store/erase.ts's subject leg; an org id IS a row
 * subject, build contract §9.5/§9.7), so erasing an org takes its registrations
 * with it.
 *
 * The TOKEN never lands in a row. It is vaulted in the store's encrypted secrets
 * under a tenant-scoped name and read back only to build a connector — `list`
 * and `register` answer descriptors and metadata, never the credential.
 */
import { mcpConnector, openApiConnector, type Connector } from "@vendoai/actions";
import {
  VendoError,
  isVendoError,
  tenantConnectorSecret,
  type Json,
  type RunContext,
  type StoreAdapter,
  type StoreOps,
  type ToolDescriptor,
  type ToolListingContext,
  type ToolRegistry,
  type VendoErrorCode,
} from "@vendoai/core";
import { assertedOrgs } from "./org-policy.js";

/** What the host registers: an MCP server URL or an OpenAPI spec, plus the
 *  bearer token the tenant pasted. */
export interface TenantConnectorInput {
  org: string;
  name: string;
  kind: "mcp" | "openapi";
  url?: string;
  spec?: string | Record<string, unknown>;
  token?: string;
}

/** Register and test both answer the same way: the tools the server really
 *  advertised, or a typed refusal. */
export type TenantConnectorResult =
  | { status: "ok"; tools: ToolDescriptor[] }
  | { status: "error"; error: { code: VendoErrorCode; message: string } };

/** One registration, as `list` reports it. Deliberately carries no `spec` and
 *  no token: this is the surface an admin screen renders. */
export interface TenantConnectorSummary {
  org: string;
  name: string;
  kind: "mcp" | "openapi";
  url?: string;
  registeredAt: string;
}

/** The dev-side API on the Vendo handle. `register` IS save-and-test: it
 *  validates by actually connecting, so a registration that landed is a
 *  registration that worked. */
export interface TenantConnectors {
  register(input: TenantConnectorInput): Promise<TenantConnectorResult>;
  list(org: string): Promise<TenantConnectorSummary[]>;
  remove(org: string, name: string): Promise<void>;
  test(org: string, name: string): Promise<TenantConnectorResult>;
}

/** Generic collection (never reserved, never dedicated) → `vendo_records`. */
const COLLECTION = "vendo_tenant_connectors";

/** An org id is the host's own, in the host's own spelling (`auth0|64f…`), so
 *  the pair is made unambiguous by ENCODING rather than by refusing characters
 *  a real identity provider mints. `encodeURIComponent` escapes the separator. */
const rowId = (org: string, name: string): string =>
  `${encodeURIComponent(org)}:${encodeURIComponent(name)}`;

/** The tenant-scoped vault name comes from core's ONE builder, because the erase
 *  cascade matches its org prefix to sweep the token (store/erase.ts). */
const secretName = tenantConnectorSecret;

/** What one row holds — everything but the credential. */
interface Registration {
  org: string;
  name: string;
  kind: "mcp" | "openapi";
  url?: string;
  spec?: string | Record<string, unknown>;
  registeredAt: string;
}

const summaryOf = (row: Registration): TenantConnectorSummary => ({
  org: row.org,
  name: row.name,
  kind: row.kind,
  ...(row.url === undefined ? {} : { url: row.url }),
  registeredAt: row.registeredAt,
});

/** A refusal the caller can branch on. A VendoError keeps its own code; anything
 *  else is the far end failing to answer, which is `unavailable` by definition. */
const failed = (error: unknown): TenantConnectorResult => ({
  status: "error",
  error: isVendoError(error)
    ? { code: error.code, message: error.message }
    : { code: "unavailable", message: error instanceof Error ? error.message : String(error) },
});

/** The registration as a live connector. The token is a SHARED tenant
 *  credential, so it rides static headers — a per-principal resolver would
 *  claim a per-user credential this seam deliberately does not have. */
function connectorFor(row: Registration, token: string | undefined): Connector {
  const headers: Record<string, string> = token === undefined ? {} : { authorization: `Bearer ${token}` };
  if (row.kind === "mcp") {
    if (row.url === undefined) {
      throw new VendoError("validation", `tenant connector "${row.name}": kind "mcp" needs a url`);
    }
    return mcpConnector({ url: row.url, headers, name: row.name });
  }
  if (row.spec === undefined) {
    throw new VendoError("validation", `tenant connector "${row.name}": kind "openapi" needs a spec`);
  }
  return openApiConnector({
    spec: row.spec,
    ...(row.url === undefined ? {} : { baseUrl: row.url }),
    headers,
    name: row.name,
  });
}

export interface ComposedTenantConnectors {
  /** The public handle. Carries no overlay affordance of any kind. */
  api: TenantConnectors;
  /** The registry this run is served, or `undefined` for the shared one. */
  overlay(ctx: ToolListingContext | RunContext | undefined): Promise<ToolRegistry | undefined>;
}

export function createTenantConnectors(deps: {
  store: StoreAdapter;
  /** The store's named-operation surface — `secrets` is where the token lives.
   *  Absent for a store that offers neither a handle nor ops, which is a store
   *  that cannot vault a credential; `register` says so instead of dropping it. */
  ops: StoreOps | undefined;
  /** One tenant's connectors as a registry of their own, under the same guard
   *  binding, connect gate and generation choke the shared registry rides. */
  bind: (connectors: Connector[]) => ToolRegistry;
}): ComposedTenantConnectors {
  const records = (): ReturnType<StoreAdapter["records"]> => deps.store.records(COLLECTION);

  const rowsFor = async (org: string): Promise<Registration[]> =>
    (await records().list({ refs: { subject: org } })).records.map((record) => record.data as unknown as Registration);

  const readToken = async (org: string, name: string): Promise<string | undefined> =>
    deps.ops === undefined ? undefined : (await deps.ops.secrets.get(secretName(org, name))) ?? undefined;

  /** Every overlay registry built so far, keyed by the run's asserted orgs. A
   *  registration change clears the WHOLE map: registering is a rare dev-side
   *  operation, and one `clear()` beats bookkeeping which keys held which org. */
  const cache = new Map<string, Promise<ToolRegistry | undefined>>();

  const api: TenantConnectors = {
    async register(input) {
      try {
        const row: Registration = {
          org: input.org,
          name: input.name,
          kind: input.kind,
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.spec === undefined ? {} : { spec: input.spec }),
          registeredAt: new Date().toISOString(),
        };
        // Validate by CONNECTING: the discovered tools are the proof, and they
        // are what the caller gets back.
        const tools = await connectorFor(row, input.token).descriptors();
        if (input.token !== undefined) {
          if (deps.ops === undefined) {
            throw new VendoError(
              "not-implemented",
              "this deployment's store has no secret vault, so a tenant connector token cannot be stored: "
              + "use the default store (or any store on the named-operation surface — Vendo Cloud, your own Postgres via createStore).",
            );
          }
          await deps.ops.secrets.set(secretName(input.org, input.name), input.token);
        }
        await records().put({
          id: rowId(input.org, input.name),
          data: row as unknown as Json,
          // The ownership stamp: an org id IS a row subject (§9.5), so the
          // existing erase cascade's subject leg reaches these rows.
          refs: { subject: input.org },
        });
        cache.clear();
        return { status: "ok", tools };
      } catch (error) {
        return failed(error);
      }
    },

    async list(org) {
      return (await rowsFor(org)).map(summaryOf);
    },

    async remove(org, name) {
      await records().delete(rowId(org, name));
      if (deps.ops !== undefined) await deps.ops.secrets.delete(secretName(org, name));
      cache.clear();
    },

    async test(org, name) {
      try {
        const row = (await records().get(rowId(org, name)))?.data as unknown as Registration | undefined;
        if (row === undefined) {
          throw new VendoError("not-found", `no tenant connector "${name}" registered for org "${org}"`);
        }
        return { status: "ok", tools: await connectorFor(row, await readToken(org, name)).descriptors() };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const connectorsFor = async (org: string): Promise<Connector[]> =>
    await Promise.all((await rowsFor(org)).map(async (row) => connectorFor(row, await readToken(row.org, row.name))));

  return {
    api,
    async overlay(ctx) {
      // `descriptors(ctx)` is typed to the listing projection, which names no
      // identity — but every caller hands down the whole RunContext (the harness
      // does, and org-policy.ts reads memberships off it the same way), so the
      // orgs are there at runtime. A ctx without them simply has no overlay.
      const orgs = assertedOrgs((ctx ?? {}) as RunContext);
      if (orgs.length === 0) return undefined;
      const key = orgs.join(",");
      let built = cache.get(key);
      if (built === undefined) {
        built = (async () => {
          const tenant = (await Promise.all(orgs.map(connectorsFor))).flat();
          return tenant.length === 0 ? undefined : deps.bind(tenant);
        })();
        // A failed build is never cached: without this one transient store blip
        // leaves a rejected promise here and every later turn rethrows it.
        built.catch(() => cache.delete(key));
        cache.set(key, built);
      }
      return built;
    },
  };
}

/** THE selection point: the shared surface, plus THIS run's tenant registry.
 *
 *  The join is a merge of two registries (the same shape @vendoai/agents' own
 *  multi-source registry takes), never a filter over one combined set — a run
 *  whose orgs registered nothing is handed the base registry untouched, and a
 *  run whose org did is handed a second registry another tenant's connector was
 *  never in. The base is asked FIRST, so a tenant server can never shadow a host
 *  tool by naming one of its own after it. */
export function withTenantOverlay(
  base: ToolRegistry,
  overlay: ComposedTenantConnectors["overlay"],
): ToolRegistry {
  return {
    async descriptors(ctx) {
      const tenant = await overlay(ctx);
      if (tenant === undefined) return base.descriptors(ctx);
      return [...await base.descriptors(ctx), ...await tenant.descriptors(ctx)];
    },
    async execute(call, ctx) {
      const tenant = await overlay(ctx);
      if (tenant !== undefined && (await tenant.descriptors()).some(({ name }) => name === call.tool)) {
        return tenant.execute(call, ctx);
      }
      return base.execute(call, ctx);
    },
  };
}
