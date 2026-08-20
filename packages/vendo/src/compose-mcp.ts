/**
 * 10-mcp — the door, in its three postures: the full public door, the
 * broker-fronted one a declared `VENDO_MCP_BROKER_URL` turns on, and the INTERNAL
 * half a machine-bound harness mounts by itself.
 */
import { VendoError } from "@vendoai/core";
import {
  canonicalUri,
  createMcpDoor,
  createTurnCredentials,
  type McpDoor,
  type McpDoorConfig,
  type TurnCredentials,
} from "@vendoai/mcp";
import { cloudMcpBundle, type McpBundle } from "./cloud-mcp.js";
import type { VendoComposition } from "./compose-context.js";
import { cloudKeyOptions } from "./compose-selection.js";
import { basePathOf, doorWellKnownPaths, MCP_MOUNT } from "./door-paths.js";
import { environment } from "./wire/shared.js";

/** The apps ride-along the door serves as a viewer + runner (10-mcp §4). */
const appsPortFor = (composition: VendoComposition): McpDoorConfig["apps"] => {
  const { apps } = composition;
  return {
      list: (ctx) => apps.list(ctx),
      async open(appId, ctx) {
        const opened = await apps.open(appId, ctx);
        if (opened.kind === "tree") return { kind: "tree", payload: opened.payload };
        if (opened.kind === "http") return { kind: "http", url: opened.url };
        throw new VendoError(
          "not-implemented",
          "This is a server app resuming in-product; open it in the host to use it over MCP.",
        );
      },
      call: (appId, ref, args, ctx) => apps.call(appId, ref, args, ctx),
  };
};

/** 10-mcp §3.1 — the DECLARED broker: `VENDO_MCP_BROKER_URL` is the tenant's own MCP
 *  endpoint, so its origin is the issuer and the endpoint itself — canonicalized
 *  with the door's own resource canonicalization, so the two can never disagree
 *  — is the audience. Malformed fails LOUD at composition, in the shape the door
 *  uses for a malformed `baseUrl`: a broker URL nobody can verify tokens against
 *  must surface as a broken deployment, never as a quiet drop to local mode. */
const declaredRemoteAs = (value: string | undefined): { issuer: string; audience: string } | undefined => {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`VENDO_MCP_BROKER_URL must be an absolute http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`VENDO_MCP_BROKER_URL must be an absolute http(s) URL, got ${JSON.stringify(value)}`);
  }
  // The door refuses credentials in a base URL; refuse them here in the same
  // words, so the message names the variable rather than an internal concept.
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("VENDO_MCP_BROKER_URL cannot contain credentials");
  }
  // RFC 8707 §2 — a resource identifier carries no fragment, and this URL
  // becomes the audience. REJECTED, never stripped: dropping it silently would
  // authenticate against an audience the operator never typed, while the one
  // they did type could never match a token the broker mints.
  if (url.hash !== "") {
    throw new TypeError(`VENDO_MCP_BROKER_URL cannot contain a fragment, got ${JSON.stringify(value)}`);
  }
  return { issuer: url.origin, audience: canonicalUri(value) };
};

/** The authorization-server half of the door's config: which external server
    (if any) fronts it, and the secret its login federation is signed with. */
type Brokerage = Pick<McpDoorConfig, "remoteAs" | "federation">;

/** ADAPTER RULE, mcp seam (cloned from selectConnections): an explicit
    `mcp.remoteAs` wins verbatim; else a declared `VENDO_MCP_BROKER_URL` fronts
    the door with that broker; else — in `composeMcp` below, because it is the
    only rung that cannot answer synchronously — Vendo Cloud; else the local
    door. The env pair is the operator's own DECLARATION and outranks Cloud for
    the same reason an explicitly passed adapter outranks it everywhere else.
    An address the app never registers anywhere is also why no boot-time call
    can repoint a live BYO deployment or swap its authentication architecture
    behind its back.

    An explicit `mcp.serviceAuth` is itself a LOCAL authorization-server choice:
    the RFC 8693 exchange it opens exists only at the door's own `/token`, which
    a `remoteAs` door does not serve (`packages/mcp/src/door.ts`). So it fills
    the same slot the env default fills, and neither the env default nor Cloud
    displaces it — a default never overrides what the host passed. The broker
    URL is still PARSED either way, so a malformed one keeps failing loudly
    instead of dropping to a local door. */
const declaredBrokerage = (mcpOptions: NonNullable<VendoComposition["mcpOptions"]>): Brokerage => {
  const declaredBroker = declaredRemoteAs(environment("VENDO_MCP_BROKER_URL"));
  const remoteAs = mcpOptions.remoteAs
    ?? (mcpOptions.serviceAuth === undefined ? declaredBroker : undefined);
  const secret = environment("VENDO_MCP_FEDERATION_SECRET");
  const federation = mcpOptions.federation ?? (secret === undefined ? undefined : { secret });
  if (mcpOptions.serviceAuth !== undefined && remoteAs !== undefined) {
    // Only reachable now with BOTH keys passed explicitly, side by side: the
    // host named an external authorization server AND asked this door for an
    // exchange only a local one can serve. The explicit `remoteAs` is honoured
    // — it is a value the door can act on, and composition throws only for
    // values it cannot (a malformed broker URL, an empty `serviceAuth.keys`).
    console.warn(
      "[vendo] mcp.serviceAuth is set alongside an explicit mcp.remoteAs, so this door trusts that "
      + "external authorization server and does not serve its own token endpoint — the service-key "
      + "exchange lives there. Exchange keys at that server instead, or drop mcp.remoteAs.",
    );
  }
  return {
    ...(remoteAs === undefined ? {} : { remoteAs }),
    ...(federation === undefined ? {} : { federation }),
  };
};

/** The Cloud rung's brokerage: the provisioned tenant's broker, and its
    federation secret for a deployment that declared none of its own. */
const cloudBrokerage = (bundle: McpBundle, declared: Brokerage): Brokerage => ({
  remoteAs: { issuer: bundle.issuer, audience: bundle.audience },
  federation: declared.federation ?? { secret: bundle.federationSecret },
});

/** A door opened on FIRST USE. Composition is sync and does no I/O, so the
    Cloud tenant is provisioned by the request that first needs it — and every
    McpDoor member is one of these two calls, so nothing can reach the door
    around the latch. */
const lazyDoor = (open: () => Promise<McpDoor>): McpDoor => {
  let opened: Promise<McpDoor> | undefined;
  const door = (): Promise<McpDoor> => (opened ??= open().catch((error: unknown) => {
    // Only a SUCCESSFUL open is the cache. Holding the rejected promise would
    // replay one console blip at every later request for the life of the
    // process — the door would never reopen, and a restart would be the only
    // cure — which is exactly what the bundle's own retry exists to prevent.
    opened = undefined;
    throw error;
  }));
  return {
    handler: async (request) => (await door()).handler(request),
    revokeClient: async (subject, clientId) => (await door()).revokeClient(subject, clientId),
  };
};

/** The `mcp:` arm: the full door, broker-fronted or local. */
const openDoor = (
  composition: VendoComposition,
  mcpOptions: NonNullable<VendoComposition["mcpOptions"]>,
  doorBaseUrl: string | undefined,
  turnCredentials: TurnCredentials,
  { remoteAs, federation }: Brokerage,
  oauth: NonNullable<VendoComposition["oauthSeam"]>,
): McpDoor => {
  const { boundTools, guard, store, ops, actions, membershipsSeam, theme } = composition;
  return createMcpDoor({
      tools: boundTools,
      guard,
      store,
      // The engine family for the door's own two drawers, over the SAME store.
      // Absent for a store with neither its own `ops` nor a SQL handle — the
      // door then serves the same verbs off the adapter itself, so an unset
      // slot is a route, not a downgrade.
      ...(ops === undefined ? {} : { ops }),
      oauth,
      apps: appsPortFor(composition),
      // The host's curated door menu (`surfaces.mcp`). Passed as a provider
      // because composition is sync and resolving the authored file is not; the
      // door resolves it once. The DOOR never reads `.vendo` itself — block
      // layering keeps mcp off actions, so the file stays the umbrella's to
      // read and the wire stays the door's to shape.
      menuTools: () => actions.surfaceMenu("mcp"),
      // Build contract §9.1 — the FOURTH door gets the same seam as the wire,
      // the harness and the automations engine. `can()` reads the caller's orgs
      // off the ctx and never queries them (§9.3), so without this an
      // `org:`/`team:` grant can never match here: a team app shared with the
      // caller would be absent from list and not-found on open, over MCP only.
      ...(membershipsSeam === undefined ? {} : { memberships: membershipsSeam }),
      // The door's SECOND credential space (10-mcp §3b): a harness bearer is
      // answered from the live turn it names, with that turn's venue, presence,
      // equipped tools and approval card. The outside-agent path is untouched —
      // the two spaces never meet (`mcp-door-outside-agent.e2e.test.ts`).
      turnCredentials,
      mount: MCP_MOUNT,
      ...(doorBaseUrl === undefined ? {} : { baseUrl: doorBaseUrl }),
      // 10-mcp §3.1/§3.2 — broker-fronted compositions: trust the external
      // authorization server's tokens and answer its login federation.
      ...(remoteAs === undefined ? {} : { remoteAs }),
      ...(federation === undefined ? {} : { federation }),
      ...(mcpOptions.serviceAuth === undefined ? {} : { serviceAuth: mcpOptions.serviceAuth }),
      ...(theme === undefined ? {} : { theme }),
  });
};

/** 10-mcp §1 — the door, its posture, and the origin-root paths it owns. */
export const composeMcp = (composition: VendoComposition): Pick<VendoComposition,
  "turnCredentials" | "door" | "mcpPosture" | "doorWellKnown" | "mcpBundle"> => {
  const { mcpOptions, internalDoorOnly, configuredBaseUrl, boundTools, guard, store } = composition;
  /**
   * 10-mcp §3b — the process's own turn-credential registry.
   *
   * Created unconditionally and BEFORE the door, because both ends attach to it:
   * the harness runtime publishes every live turn here, and a composed door
   * resolves harness bearers through it. It grants nothing on its own — a
   * credential only exists once a harness mints one from inside its own turn.
   */
  const turnCredentials: TurnCredentials = createTurnCredentials();
  // The door's canonical public base — the operator-set VENDO_BASE_URL, or the
  // explicit `mcp.baseUrl` for a composition whose door origin differs from the
  // route-binding one (see the pin below). Read here rather than inside the
  // branch because the path prefix it carries also decides which well-known
  // spellings the umbrella hands the door (`doorWellKnownPaths`).
  const doorBaseUrl = mcpOptions?.baseUrl ?? configuredBaseUrl;
  let door: McpDoor | undefined;
  // The /status posture for the mcp block (connections-posture pattern):
  // false when the door is closed, "local" when it serves its own OAuth
  // surface, "broker" when an external authorization server fronts it —
  // declared by VENDO_MCP_BROKER_URL or configured explicitly.
  let mcpPosture: "local" | "broker" | false = false;
  // The Cloud tenant's bundle, for the door AND for `vendo.tokenFor` — one
  // provisioning shared by both, so a minted token can never name a broker the
  // door does not trust.
  let mcpBundle: (() => Promise<McpBundle>) | undefined;
  if (mcpOptions !== undefined) {
    const { oauthSeam } = composition;
    if (oauthSeam === undefined) {
      throw new VendoError(
        "validation",
        "createVendo({ mcp: true }) requires a HostOAuthAdapter (10-mcp §3) — from `oauth` or an `auth` preset carrying one: the door mints door principals through it and cannot open without one.",
      );
    }
    const declared = declaredBrokerage(mcpOptions);
    // The Cloud rung of the seam above: it fills the brokerage slot only when
    // nothing explicit and nothing declared already has.
    const cloud = declared.remoteAs === undefined && mcpOptions.serviceAuth === undefined
      ? cloudKeyOptions()
      : undefined;
    if (cloud === undefined) {
      door = openDoor(composition, mcpOptions, doorBaseUrl, turnCredentials, declared, oauthSeam);
      mcpPosture = declared.remoteAs === undefined ? "local" : "broker";
    } else {
      const bundle = cloudMcpBundle(cloud, doorBaseUrl);
      mcpBundle = bundle;
      door = lazyDoor(async () => openDoor(
        composition, mcpOptions, doorBaseUrl, turnCredentials, cloudBrokerage(await bundle(), declared), oauthSeam,
      ));
      // Known without the fetch: the key decided the posture, the console only
      // supplies the address — so /status never has to wait on the network.
      mcpPosture = "broker";
    }
  } else if (internalDoorOnly) {
    // The INTERNAL half alone. It answers one live turn's credential and
    // nothing else, so it is handed only what that leg reads: the credential
    // registry and where it lives. No oauth (there is no space to sign into),
    // no apps ride-alongs, no `surfaces.mcp` menu, no theme — a turn's tools,
    // curation and rendering are all decided by the turn. The broker seam
    // never applies here: there is no outside OAuth surface for an external
    // authorization server to front, so this half keeps `mcp: false` posture
    // like any closed door.
    door = createMcpDoor({
      internal: true,
      tools: boundTools,
      guard,
      store,
      turnCredentials,
      mount: MCP_MOUNT,
      ...(configuredBaseUrl === undefined ? {} : { baseUrl: configuredBaseUrl }),
    });
  }
  // Resolved AFTER the door: `createMcpDoor` is what validates the base URL, so
  // a malformed one still fails with its message rather than a bare `new URL`.
  const doorWellKnown = doorWellKnownPaths(door === undefined ? "" : basePathOf(doorBaseUrl));
  return { turnCredentials, door, mcpPosture, doorWellKnown, mcpBundle };
};
