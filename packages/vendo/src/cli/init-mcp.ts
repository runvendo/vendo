/**
 * 10-mcp — what `vendo init` writes when the user wants outside agents (Claude,
 * ChatGPT, Cursor) to act in their product as the signed-in user.
 *
 * Two of the three things the docs call "host decisions" stop being decisions
 * the moment the user picks this path: init CREATES the composition, so writing
 * `mcp: true` into it is not editing anyone's code, and the origin-root
 * discovery route is a new file at a fixed path with a fixed two-line body.
 * What is left for the user — the deployed base URL, pointing a client at the
 * door, the broker's environment overrides — is the docs page's, not the
 * terminal's: init states what it wired and links to
 * https://docs.vendo.run/outside-agents/quickstart.
 *
 * PURE: no fs, no network, no clock. Every file body, step line and environment
 * line is decided from the answers alone, so the whole plan is assertable
 * without a temp directory — and the caller stays the only thing that touches
 * the disk.
 */
import { randomBytes } from "node:crypto";
import { join, relative, sep } from "node:path";
import type { AuthWire } from "./init-auth.js";
import { authOwnSeamLines, compositionModuleSource, type ScaffoldModel } from "./init-scaffolds.js";

/** Which authorization server fronts the door. Init no longer ASKS this — a
    Cloud key answers both environments at once, and the runtime resolves which
    one it is per environment (compose-mcp.ts) — so it arrives only as the
    `--posture` flag, for a host that wants a Cloud-fronted-only door. Init
    still never discovers a posture and never reaches a broker to find out. */
export type McpPosture = "local" | "broker";

export interface McpPlanInput {
  root: string;
  /** The host's app directory (`app` or `src/app`), already resolved. */
  appDir: string;
  /** The composition module the wire route already imports (`lib/vendo.ts`),
      absolute — this path CHANGES what it holds rather than gaining a second
      composition next to the route, and the discovery route imports the same
      one. Resolved by the caller: this module stays fs-free. */
  composition: string;
  /** How the discovery route reaches it (`compositionSpecifier`). */
  compositionSpecifier: string;
  framework: "next" | "express" | "custom";
  /**
   * What the fresh composition wired, or null. `mcp: true` is written ONLY
   * when this is non-null: the door mints its own principals through a
   * `HostOAuthAdapter` and composition THROWS without one (compose-mcp.ts:77-82).
   * Every preset carries the oauth half — `jwt()` composes through the same
   * `composeHostAuthPreset` the vendor ones do (auth-presets/identity.ts:228-246)
   * — and so does the hand-written seam, whose whole point is that `oauth`.
   * Only "none yet" surfaces here as null, and only it is refused.
   */
  authWired: AuthWire | null;
  /**
   * Does the composition ALREADY on disk wire one of those presets? A re-run
   * over an existing composition asks no auth question — init never rewrites a
   * file it did not author — so `authWired` is null even for a host whose
   * `lib/vendo.ts` says `auth: authJs()`, and refusing on that alone told a
   * correctly wired host to "wire an auth preset" and wrote no door at all.
   * Resolved by the caller (`composedAuthPreset`); this module stays fs-free.
   *
   * Never true at the same time as a non-null `authWired`: init only decides
   * auth for a composition it is CREATING, and then there is nothing on disk.
   */
  authAlreadyWired?: boolean;
  /** Does the host have a live `"use server"` surface? The composition imports
      the generated registration map when it does. The map itself stays the
      caller's to plan: an EXISTING one is compared by the keys it registers,
      which a pure planner cannot read. */
  serverActions: boolean;
  posture: McpPosture;
  /** Wire the dev sign-in key. Not a question any more: a local door gets one by
      default, because `.env.local` is dev-only and the deployment — which never
      sees the variable — takes the Cloud broker instead (compose-mcp.ts). */
  serviceKey: boolean;
  /** A well-formed `VENDO_SERVICE_KEY` already in the host's env files, to
      REUSE. Minting one unconditionally rotated the secret on every re-run and
      the caller then overwrote .env.local with it, so every backend already
      exchanging the old key started failing — the same reuse-don't-remint rule
      `VENDO_API_KEY` follows. Read by the caller; this module stays fs-free. */
  existingServiceKey?: string;
  /** The provider key init found in the environment. This path's composition
      module is the ONLY place it may land: the thin route composes nothing, so
      writing it there too would be a second, dead selection. */
  models?: ScaffoldModel | null;
}

/** A file the MCP path creates. Always new — `before` is null for every one of
    them — so the caller renders the diff it already knows how to render. */
export interface McpChange {
  absolute: string;
  /** Root-relative, posix-style: the path the summary prints. */
  path: string;
  after: string;
}

export interface McpPlan {
  /** The one file the MCP path ADDS: the origin-root discovery route. */
  changes: McpChange[];
  /** The composition module's body, with the door opened. Separate from
      `changes` because the composition is a file the caller may already have on
      disk, and a pure planner cannot know that — the caller pushes it with the
      `before` it already read. Null when the plan is `blocked`. */
  compositionSource: string | null;
  /**
   * The service key the composition wires, for the caller to write to
   * `.env.local` — `existingServiceKey` when the host already has a well-formed
   * one, else freshly minted.
   * Present on local posture with a yes, and NOWHERE else. `serviceAuth` is
   * local-door mechanics: the RFC 8693 exchange lives at the door's own
   * `/token`, which a broker-fronted door does not serve — and an explicit
   * local `serviceAuth` is host config that beats the env default, so
   * generating one under broker posture would quietly hold the door LOCAL
   * against the posture the user just chose (compose-mcp.ts:98-113).
   */
  serviceKeyValue?: string;
  /** The provider and file of the `models` line this plan wrote — the
      composition module, never the route it replaced. The caller's closing
      summary names this file, so it can never point a reader at a route that
      holds nothing. Null when no provider key resolved or the plan is
      `blocked`. */
  modelWritten: { provider: ScaffoldModel["provider"]; path: string } | null;
  /** Why nothing was written. Set means the other fields are empty. */
  blocked?: string;
  /** …and whether the RUN may continue. An auth-less door is the use case
      itself failing — the user asked for MCP, there is no door, and exiting 0
      is how init used to say "Wired" over an install that answered nothing
      they came for. A non-Next host is a different shape: its whole install
      still lands and only the door is hand-work, so that one stays advisory. */
  blockedFatal?: true;
}

/** The recipe the auth refusal prints: the seam `--auth custom` would have
    written, so a reader who does not want a vendor preset can paste it into the
    composition they already have instead of re-running anything. Rendered from
    the SAME function init scaffolds with — one copy, or the printed recipe
    drifts from the written one. */
export const OWN_SEAM_RECIPE = authOwnSeamLines(true).replace(/^/gm, "  ").trimEnd();

/** Why a service key cannot ride the broker posture, in the ONE voice both
    refusals speak: `cli.ts` catches the flag pair it can read off argv, and
    init catches a posture chosen at the select, which never reaches argv. The
    lead-in differs because the user did two different things; the explanation
    and the way out must not. */
export const SERVICE_KEY_ON_BROKER =
  "a Cloud-fronted door's service key is provisioned with the tenant on first use, so this one would be "
  + "discarded. Drop --service-key, or pass --posture local to declare your own "
  + "(https://docs.vendo.run/outside-agents/service-keys-and-broker)";

/** Why a Cloud-fronted door cannot stand on an http origin. Cloud registers
    `VENDO_BASE_URL` as the tenant's forwarding address and refuses one that is
    not https, so the two answers used to pass init, print `Wired`, and leave a
    door that died on its first request. Same shape as the refusal above: the
    lead-in names the origin, this says why and how out. */
export const BROKER_NEEDS_HTTPS =
  "Vendo Cloud registers that origin as the tenant's forwarding address and refuses one that is not https, "
  + "so this door would be written now and fail on its first request. Take the local posture — zero config, "
  + "and it works on http — or re-run with --base-url set to an https origin "
  + "(https://docs.vendo.run/outside-agents/quickstart)";

/** A fresh service key: 32 random bytes, hex. `planMcp` mints one itself when
    the answers call for it AND the host has none to reuse; this is separately
    callable so the shape can be asserted without a plan. */
export function generateServiceKey(): string {
  return randomBytes(32).toString("hex");
}

/** Is the value already in the host's env a key this door can exchange? The
    shape `generateServiceKey` mints, and nothing else: anything other than 32
    hex bytes is not reusable, so it is replaced rather than trusted. */
export function wellFormedServiceKey(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && /^[0-9a-f]{64}$/i.test(value.trim());
}

/**
 * The origin-root discovery route (`app/.well-known/[...vendo]/route.ts`).
 *
 * A two-line body over the SAME instance the wire route serves:
 * `wellKnownVendoHandler` resolves its path set by instance identity
 * (server.ts:447-452), so a second `createVendo` call in this file would answer
 * 404 on every well-known path — which is precisely the bug this route exists
 * to prevent.
 */
export function wellKnownRouteSource(specifier: string): string {
  return `// The door's discovery documents live at ORIGIN-ROOT paths, outside\n` +
    `// /api/vendo, so Next.js never routes them to the catch-all. This file is\n` +
    `// that handler. It MUST share the wire's instance — the path set is resolved\n` +
    `// by instance identity, so a second createVendo() here 404s every path.\n` +
    `import { wellKnownVendoHandler } from "@vendoai/vendo/server";\n` +
    `import { vendo } from ${JSON.stringify(specifier)};\n\n` +
    `export const { GET, POST } = wellKnownVendoHandler(vendo);\n`;
}

export function planMcp(input: McpPlanInput): McpPlan {
  const { root, appDir, composition, framework, authWired, serverActions, posture, serviceKey } = input;
  const models = input.models ?? null;
  const refuse = (why: string, fatal?: true): McpPlan => ({
    changes: [],
    compositionSource: null,
    modelWritten: null,
    blocked: why,
    ...(fatal === undefined ? {} : { blockedFatal: fatal }),
  });

  if (framework !== "next") {
    return refuse(
      "MCP scaffolding is Next.js-only: the discovery documents live at origin-root paths, which only a "
      + "file-routed app directory can claim. Open the door by hand instead — pass `mcp: true` to createVendo "
      + "and serve the well-known paths from your runtime: https://docs.vendo.run/outside-agents/quickstart.",
    );
  }
  if (authWired === null && input.authAlreadyWired !== true) {
    // FATAL, and refused before a single file is written. This is the MCP use
    // case failing whole: outside agents sign in as somebody, and "none yet" is
    // nobody. Init used to print this as a warning, write the anonymous
    // composition anyway and exit 0 — which then made a re-run useless, because
    // init never rewrites a composition it already wrote. Nothing is written
    // now, so answering the question again is the entire fix.
    return refuse(
      "You chose MCP and this run wired no door, so nothing was written at all. "
      + "The door mints its own principals through an OAuth adapter, and \"none yet\" leaves an "
      + "anonymous composition that has none. Re-run `npx vendo init --use-case mcp` and answer "
      + "\"How do your users sign in?\" with your provider — Auth.js, Clerk, Supabase, Auth0 and JWT "
      + "all carry the adapter — or with \"write my own\", which scaffolds this working seam for you:\n"
      + `${OWN_SEAM_RECIPE}\n`
      + "Details: https://docs.vendo.run/outside-agents/quickstart.",
      true,
    );
  }

  const wellKnownDir = join(appDir, ".well-known", "[...vendo]");
  const change = (absolute: string, after: string): McpChange => ({
    absolute,
    path: relative(root, absolute).split(sep).join("/"),
    after,
  });

  // `serviceAuth` is wired only under local posture: see McpPlan.serviceKeyValue.
  const serviceAuth = posture === "local" && serviceKey;
  const changes: McpChange[] = [change(join(wellKnownDir, "route.ts"), wellKnownRouteSource(input.compositionSpecifier))];

  return {
    changes,
    compositionSource: compositionModuleSource({ serverActions, auth: authWired, models, mcp: { serviceAuth } }),
    ...(serviceAuth
      ? { serviceKeyValue: wellFormedServiceKey(input.existingServiceKey) ? input.existingServiceKey!.trim() : generateServiceKey() }
      : {}),
    modelWritten: models === null ? null : { provider: models.provider, path: relative(root, composition).split(sep).join("/") },
  };
}
