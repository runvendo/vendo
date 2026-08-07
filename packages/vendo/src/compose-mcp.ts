/**
 * 10-mcp — the door, in its three postures: the full public door, the
 * broker-fronted one an ensure-tenant call wires, and the INTERNAL half a
 * machine-bound harness mounts by itself.
 */
import { VendoError } from "@vendoai/core";
import {
  createMcpDoor,
  createTurnCredentials,
  type AppsPort,
  type McpDoor,
  type TurnCredentials,
} from "@vendoai/mcp";
import { cloudKeyOptions } from "./compose-selection.js";
import type { VendoComposition } from "./compose-context.js";
import { cloudMcpTenant } from "./cloud-mcp.js";
import { basePathOf, doorWellKnownPaths, MCP_MOUNT } from "./door-paths.js";
import { selectMcpBroker } from "./mcp-broker-select.js";

/** The apps ride-along the door serves as a viewer + runner (10-mcp §4). */
const appsPortFor = (composition: VendoComposition): AppsPort => {
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

/** 10-mcp §5 — the door, built from the parts already assembled. Taken as a
 *  factory because the broker arm re-composes it with the trust anchor the
 *  ensure-tenant call returns. */
const doorFactory = (
  composition: VendoComposition,
  mcpOptions: NonNullable<VendoComposition["mcpOptions"]>,
  doorBaseUrl: string | undefined,
  turnCredentials: TurnCredentials,
): (remoteAs?: typeof mcpOptions.remoteAs, federation?: typeof mcpOptions.federation) => McpDoor => {
  const { boundTools, guard, store, oauthSeam, actions, membershipsSeam, theme } = composition;
  const appsPort = appsPortFor(composition);
    const composeDoor = (
      remoteAs = mcpOptions.remoteAs,
      federation = mcpOptions.federation,
    ): McpDoor => createMcpDoor({
      tools: boundTools,
      guard,
      store,
      oauth: oauthSeam,
      apps: appsPort,
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
  return composeDoor;
};

interface OpenedDoor {
  door: McpDoor;
  posture: "local" | "broker";
  selection: VendoComposition["mcpSelection"];
  warmMcpBroker?: () => Promise<void>;
}

/** The `mcp:` arm: the full door, brokered or local. */
const openDoor = (
  composition: VendoComposition,
  mcpOptions: NonNullable<VendoComposition["mcpOptions"]>,
  doorBaseUrl: string | undefined,
  turnCredentials: TurnCredentials,
): OpenedDoor => {
  const { oauthSeam } = composition;
  if (oauthSeam === undefined) {
    throw new VendoError(
      "validation",
      "createVendo({ mcp: true }) requires a HostOAuthAdapter (10-mcp §3) — from `oauth` or an `auth` preset carrying one: the door mints door principals through it and cannot open without one.",
    );
  }
  const composeDoor = doorFactory(composition, mcpOptions, doorBaseUrl, turnCredentials);
  // ADAPTER RULE, mcp seam (selectMcpBroker — cloned from selectConnections
  // above): explicit `mcp.remoteAs` wins verbatim; else VENDO_API_KEY plus a
  // PUBLIC base URL default the hosted broker (an idempotent ensure-tenant
  // call wires remoteAs + federation from the response); else the local
  // door, byte-identical to today. The localhost rule and the ensure wire
  // are frozen in the provisioning plan.
  const mcpCloud = cloudKeyOptions();
  const selection = selectMcpBroker(mcpOptions, mcpCloud, doorBaseUrl, MCP_MOUNT);
  if (mcpOptions.serviceAuth !== undefined && (selection.mode === "broker" || selection.mode === "explicit")) {
    console.warn(
      "[vendo] mcp.serviceAuth is set, but this door trusts an external authorization server "
      + "(mcp.remoteAs, or the hosted broker VENDO_API_KEY selects), so it does not serve its own "
      + "token endpoint — the service-key exchange lives there. Exchange keys at that server instead.",
    );
  }
  if (selection.mode === "broker" && mcpCloud !== undefined) {
    // Boot-once, awaited: the first door construction rides the ready latch
    // (warmMcpBroker below) so the trust anchor is resolved before the first
    // request is served — and the wrapper below awaits the same latch, so a
    // door request can never race a half-composed door.
    let brokerDoor: Promise<McpDoor> | undefined;
    const composeBrokerDoor = async (): Promise<McpDoor> => {
      try {
        const { tenant, federationSecret } = await cloudMcpTenant(mcpCloud).ensure(selection.ensure);
        return composeDoor(
          { issuer: tenant.issuer, audience: tenant.audience },
          { secret: federationSecret },
        );
      } catch (error) {
        // Same degrade posture as the hosted overrides fetch above: a
        // console blip must not kill boot. Loud, once, then the local door
        // for this composition's lifetime; the next boot re-ensures.
        composition.mcpPosture = "local";
        console.warn(
          "[vendo] hosted MCP broker ensure-tenant failed; the door serves its own local OAuth "
          + `surface this boot: ${error instanceof Error ? error.message : String(error)}`,
        );
        return composeDoor();
      }
    };
    const doorReady = (): Promise<McpDoor> => (brokerDoor ??= composeBrokerDoor());
    const warmMcpBroker = async (): Promise<void> => { await doorReady(); };
    return {
      door: {
        handler: async (request) => (await doorReady()).handler(request),
        revokeClient: async (subject, clientId) => (await doorReady()).revokeClient(subject, clientId),
      },
      posture: "broker",
      selection: selection.mode,
      warmMcpBroker,
    };
  }
  return {
    door: composeDoor(),
    posture: selection.mode === "explicit" ? "broker" : "local",
    selection: selection.mode,
  };
};

/** 10-mcp §1 — the door, its posture, and the origin-root paths it owns. */
export const composeMcp = (composition: VendoComposition): Pick<VendoComposition,
  "turnCredentials" | "door" | "mcpPosture" | "mcpSelection" | "doorWellKnown" | "warmMcpBroker"> => {
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
  // ensured from the Cloud broker or explicitly configured. A `let` read
  // through a deps getter, so the ensure-failure degrade below reports what
  // actually composed.
  let mcpPosture: "local" | "broker" | false = false;
  // The seam's selection, kept beside the posture for the dev-only
  // /doctor/mcp probe (wire/doctor.ts): the posture collapses explicit
  // `mcp.remoteAs` and the Cloud-managed broker into "broker", and doctor
  // needs the distinction to never ensure a tenant for an explicit AS.
  let mcpSelection: "off" | "explicit" | "broker" | "local" = "off";
  let warmMcpBroker: (() => Promise<void>) | undefined;
  if (mcpOptions !== undefined) {
    const opened = openDoor(composition, mcpOptions, doorBaseUrl, turnCredentials);
    door = opened.door;
    mcpPosture = opened.posture;
    mcpSelection = opened.selection;
    warmMcpBroker = opened.warmMcpBroker;
  } else if (internalDoorOnly) {
    // The INTERNAL half alone. It answers one live turn's credential and
    // nothing else, so it is handed only what that leg reads: the credential
    // registry and where it lives. No oauth (there is no space to sign into),
    // no apps ride-alongs, no `surfaces.mcp` menu, no theme — a turn's tools,
    // curation and rendering are all decided by the turn. The broker seam
    // (selectMcpBroker above) never applies here: there is no outside OAuth
    // surface for an external authorization server to front, so this half
    // keeps `mcp: false` posture like any closed door.
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
  return {
    turnCredentials,
    door,
    mcpPosture,
    mcpSelection,
    doorWellKnown,
    ...(warmMcpBroker === undefined ? {} : { warmMcpBroker }),
  };
};
