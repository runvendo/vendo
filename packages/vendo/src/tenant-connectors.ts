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
  /** Whether this registration put a token in the vault. The row has to say so,
   *  because ASKING is not free: a store with no encryption key refuses the read
   *  itself (store/secrets.ts's `keyFor`) before it ever looks for a row, so one
   *  tokenless registration would throw on every turn for every member of the
   *  org. A connector that needs no credential must cost no vault read. */
  vaulted?: true;
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
  /** The registries this run's asserted orgs add to the shared one, in the
   *  order they were asserted. Empty for a run that asserts no org, or whose
   *  orgs have registered nothing. */
  overlay(ctx: ToolListingContext | RunContext | undefined): Promise<ToolRegistry[]>;
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

  const readToken = async (row: Registration): Promise<string | undefined> =>
    row.vaulted === true && deps.ops !== undefined
      ? (await deps.ops.secrets.get(secretName(row.org, row.name))) ?? undefined
      : undefined;

  /** ONE registry per ORG, keyed by the org id itself — never one per membership
   *  COMBINATION. Two orgs' connectors sharing a registration name compose the
   *  same tool name, and a shared registry answers that with a `conflict` throw
   *  (actions/runtime/registry.ts) that takes the whole listing down, host tools
   *  included, for a person who merely belongs to both. Kept apart, each org's
   *  registry only ever sees its own connectors, so the collision cannot form;
   *  the merge below is where the two meet, and it is a de-duplication, not a
   *  build. A plain org id is also unambiguous as a key, which a joined list of
   *  them would not be. */
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
          ...(input.token === undefined ? {} : { vaulted: true as const }),
        };
        // Validate by CONNECTING: the discovered tools are the proof, and they
        // are what the caller gets back.
        const tools = await connectorFor(row, input.token).descriptors();
        if (input.token !== undefined && deps.ops === undefined) {
          throw new VendoError(
            "not-implemented",
            "this deployment's store has no secret vault, so a tenant connector token cannot be stored: "
            + "use the default store (or any store on the named-operation surface — Vendo Cloud, your own Postgres via createStore).",
          );
        }
        if (deps.ops !== undefined) {
          // The vault always ends up holding exactly what this call VALIDATED
          // with. A re-registration that pasted no token drops the old one
          // instead of leaving runtime to send a credential to a url its owner
          // never paired it with — which is also the only way `register`'s
          // discovery and the later live calls can be the same request.
          const vaulted = secretName(input.org, input.name);
          if (input.token === undefined) await deps.ops.secrets.delete(vaulted);
          else await deps.ops.secrets.set(vaulted, input.token);
        }
        await records().put({
          id: rowId(input.org, input.name),
          data: row as unknown as Json,
          // The ownership stamp: an org id IS a row subject (§9.5), so the
          // existing erase cascade's subject leg reaches these rows.
          refs: { subject: input.org },
        });
        cache.delete(input.org);
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
      cache.delete(org);
    },

    async test(org, name) {
      try {
        const row = (await records().get(rowId(org, name)))?.data as unknown as Registration | undefined;
        if (row === undefined) {
          throw new VendoError("not-found", `no tenant connector "${name}" registered for org "${org}"`);
        }
        return { status: "ok", tools: await connectorFor(row, await readToken(row)).descriptors() };
      } catch (error) {
        return failed(error);
      }
    },
  };

  const connectorsFor = async (org: string): Promise<Connector[]> =>
    await Promise.all((await rowsFor(org)).map(async (row) => connectorFor(row, await readToken(row))));

  const registryFor = (org: string): Promise<ToolRegistry | undefined> => {
    let built = cache.get(org);
    if (built === undefined) {
      built = (async () => {
        const connectors = await connectorsFor(org);
        return connectors.length === 0 ? undefined : deps.bind(connectors);
      })();
      // A failed build is never cached: without this one transient store blip
      // leaves a rejected promise here and every later turn rethrows it.
      built.catch(() => cache.delete(org));
      cache.set(org, built);
    }
    return built;
  };

  return {
    api,
    async overlay(ctx) {
      // `descriptors(ctx)` is typed to the listing projection, which names no
      // identity — but every caller hands down the whole RunContext (the harness
      // does, and org-policy.ts reads memberships off it the same way), so the
      // orgs are there at runtime. A ctx without them simply has no overlay.
      const orgs = assertedOrgs((ctx ?? {}) as RunContext);
      const registries = await Promise.all(orgs.map(registryFor));
      return registries.filter((registry): registry is ToolRegistry => registry !== undefined);
    },
  };
}

/** THE selection point: the shared surface, plus the registries this run's orgs
 *  add to it.
 *
 *  A merge of registries (the same shape @vendoai/agents' own multi-source
 *  registry takes), never a filter over one combined set — a run whose orgs
 *  registered nothing is handed the base registry untouched, and a run whose org
 *  did is handed a registry another tenant's connector was never in.
 *
 *  ONE order decides everything, and the base leads it. A name the base carries
 *  is the base's, so a tenant server can never shadow a host tool by naming one
 *  of its own after it; after that, the first org the caller asserted wins. The
 *  listing and the dispatch walk that same order, so the tool a person is
 *  offered is always the tool that runs. */
export function withTenantOverlay(
  base: ToolRegistry,
  overlay: ComposedTenantConnectors["overlay"],
): ToolRegistry {
  return {
    async descriptors(ctx) {
      const tenants = await overlay(ctx);
      if (tenants.length === 0) return base.descriptors(ctx);
      // A copy: the registries below cache the array they answer with, and
      // appending to it would rewrite the deployment's own tool surface.
      const merged = [...await base.descriptors(ctx)];
      const taken = new Set(merged.map(({ name }) => name));
      for (const tenant of tenants) {
        for (const descriptor of await tenant.descriptors(ctx)) {
          if (taken.has(descriptor.name)) continue;
          taken.add(descriptor.name);
          merged.push(descriptor);
        }
      }
      return merged;
    },
    async execute(call, ctx) {
      const tenants = await overlay(ctx);
      if (tenants.length === 0) return base.execute(call, ctx);
      for (const registry of [base, ...tenants]) {
        // The run's OWN ctx, never an unprojected read: who owns a name is a
        // question about this caller, and the base answers it differently for
        // an unattended run than for an attended one.
        if ((await registry.descriptors(ctx)).some(({ name }) => name === call.tool)) {
          return registry.execute(call, ctx);
        }
      }
      // Claimed by nobody: the base answers, so an unknown name gets the same
      // not-found the rest of the deployment already produces.
      return base.execute(call, ctx);
    },
  };
}
