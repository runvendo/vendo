/**
 * 10-mcp — what `vendo init` writes when the user wants outside agents (Claude,
 * ChatGPT, Cursor) to act in their product as the signed-in user.
 *
 * Two of the three things the docs call "host decisions" stop being decisions
 * the moment the user picks this path: init CREATES the composition, so writing
 * `mcp: true` into it is not editing anyone's code, and the origin-root
 * discovery route is a new file at a fixed path with a fixed two-line body.
 * Exactly two things stay the user's, and they are the two init genuinely
 * cannot do — set the base URL where they deploy, and point a client at the
 * door. They are `steps`, named rather than buried.
 *
 * PURE: no fs, no network, no clock. Every file body, step line and environment
 * line is decided from the answers alone, so the whole plan is assertable
 * without a temp directory — and the caller stays the only thing that touches
 * the disk.
 */
import { randomBytes } from "node:crypto";
import { join, relative, sep } from "node:path";
import { MCP_MOUNT } from "../door-paths.js";
import type { AuthMatch } from "./init-auth.js";
import { compositionModuleSource, routeSource } from "./init-scaffolds.js";

/** Which authorization server fronts the door. DECLARED by the operator and
    nothing else (10-mcp §3.1) — init prints environment lines, it never
    discovers posture and never reaches a broker to find out. */
export type McpPosture = "local" | "broker";

export interface McpPlanInput {
  root: string;
  /** The host's app directory (`app` or `src/app`), already resolved. */
  appDir: string;
  framework: "next" | "express" | "custom";
  /**
   * The preset the fresh composition wired, or null. `mcp: true` is written
   * ONLY when this is non-null: the door mints its own principals through a
   * `HostOAuthAdapter` and composition THROWS without one (compose-mcp.ts:77-82).
   * Every zero-arg preset carries the oauth half (auth-presets/identity.ts:215-231);
   * `jwt` and "none" do not, and both surface here as null.
   */
  authWired: AuthMatch | null;
  /** Does the host have a live `"use server"` surface? The composition imports
      the generated registration map when it does. The map itself stays the
      caller's to plan: an EXISTING one is compared by the keys it registers,
      which a pure planner cannot read. */
  serverActions: boolean;
  /** Is a Vendo Cloud key in hand this run? Gates the posture select: a keyless
      run never sees it — local is the default and the broker keeps today's
      one-line pointer. */
  cloudKey: boolean;
  posture: McpPosture;
  /** Did the user say yes to "will your own backend call these tools
      machine-to-machine?" */
  serviceKey: boolean;
  /** The public origin captured earlier this run, or null when the user skipped
      the question. */
  baseUrl: string | null;
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
  /** The files the MCP path adds ALONGSIDE the route the caller already plans:
      the composition module and the origin-root discovery route. */
  changes: McpChange[];
  /** The thin `route.ts` body. Separate from `changes` because the route is the
      one file the caller may already have on disk, and a pure planner cannot
      know that — the caller pushes it with the `before` it already read. Null
      when the plan is `blocked`. */
  routeSource: string | null;
  /**
   * The generated service key, for the caller to write to `.env.local`.
   * Present on local posture with a yes, and NOWHERE else. `serviceAuth` is
   * local-door mechanics: the RFC 8693 exchange lives at the door's own
   * `/token`, which a broker-fronted door does not serve — and an explicit
   * local `serviceAuth` is host config that beats the env default, so
   * generating one under broker posture would quietly hold the door LOCAL
   * against the posture the user just chose (compose-mcp.ts:98-113).
   */
  serviceKeyValue?: string;
  /** The lines the run ends on. The FIRST is ALWAYS the base URL: a door whose
      discovery points at the wrong origin surfaces hours later as "Claude can't
      find my server". */
  steps: string[];
  /** Environment lines the operator sets where they deploy (broker posture). */
  envLines: string[];
  /** Why nothing was written. Set means the other fields are empty. */
  blocked?: string;
}

/** The plan's closing block, as a pretty run reads it: each step numbered by
    its headline, its detail indented under it, and the environment values as a
    closing group under one sentence that says where they go. A flat list of
    `headline\ndetail` strings reads as a wall — the numbers and the indent are
    what make it read as steps. (Plain runs print the same strings unnumbered:
    the newline becomes an indent and nothing else, since a plain transcript is
    parsed as often as it is read.) */
export function mcpStepLines(plan: Pick<McpPlan, "steps" | "envLines">): string[] {
  const lines: string[] = [];
  plan.steps.forEach((step, index) => {
    const [headline, ...detail] = step.split("\n");
    lines.push(`${index + 1}. ${headline}`);
    for (const rest of detail) lines.push(`   ${rest}`);
  });
  if (plan.envLines.length > 0) {
    lines.push("", "Set where you deploy — both values live on the console's MCP page:");
    for (const env of plan.envLines) lines.push(`   ${env}`);
  }
  return lines;
}

/** A fresh service key: 32 random bytes, hex. `planMcp` mints one itself when
    the answers call for it; this is separately callable so the shape can be
    asserted without a plan. */
export function generateServiceKey(): string {
  return randomBytes(32).toString("hex");
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

/** An import specifier from one generated directory to another, posix-style and
    always explicitly relative. */
function specifierBetween(fromDir: string, target: string): string {
  const path = relative(fromDir, target).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

/** The keyless sign-in pointer — today's two lines of prose, kept exactly where
    they are useful. A run with no Cloud key is never shown the posture select,
    so this is the whole story it gets. */
const KEYLESS_SIGN_IN =
  "Sign-in: your app serves its own OAuth — nothing to configure. Set VENDO_MCP_BROKER_URL "
  + "to front it with an external authorization server (e.g. Vendo Cloud's broker) — "
  + "same client URL either way.";

export function planMcp(input: McpPlanInput): McpPlan {
  const { root, appDir, framework, authWired, serverActions, cloudKey, posture, serviceKey, baseUrl } = input;
  const refuse = (why: string): McpPlan => ({ changes: [], routeSource: null, steps: [], envLines: [], blocked: why });

  if (framework !== "next") {
    return refuse(
      "MCP scaffolding is Next.js-only: the discovery documents live at origin-root paths, which only a "
      + "file-routed app directory can claim. Open the door by hand instead — pass `mcp: true` to createVendo "
      + "and serve the well-known paths from your runtime: https://docs.vendo.run/existing-agents/mcp.",
    );
  }
  if (authWired === null) {
    return refuse(
      "The MCP door mints its own principals through an OAuth adapter and cannot open without one, so "
      + "nothing MCP was written. Wire an auth preset — auth: clerk(), authJs(), supabase() or auth0() all "
      + "carry it — then re-run `npx vendo init`. (jwt() and an anonymous composition do not carry the "
      + "oauth half: https://docs.vendo.run/existing-agents/mcp.)",
    );
  }

  const wiringDir = join(appDir, "api", "vendo", "[...vendo]");
  const wellKnownDir = join(appDir, ".well-known", "[...vendo]");
  const composition = join(wiringDir, "vendo.ts");
  const change = (absolute: string, after: string): McpChange => ({
    absolute,
    path: relative(root, absolute).split(sep).join("/"),
    after,
  });

  // `serviceAuth` is wired only under local posture: see McpPlan.serviceKeyValue.
  const serviceAuth = posture === "local" && serviceKey;
  const changes: McpChange[] = [
    change(composition, compositionModuleSource({ serverActions, auth: authWired, serviceAuth })),
    change(
      join(wellKnownDir, "route.ts"),
      wellKnownRouteSource(specifierBetween(wellKnownDir, join(wiringDir, "vendo"))),
    ),
  ];

  // The client-facing URL is derived from the base URL and NEVER from the broker
  // URL, so it is the same in both postures — switching posture later invalidates
  // nothing a user already configured in Claude, ChatGPT or Cursor.
  const clientBase = baseUrl ?? "https://<your deployment>";
  // Each step is "headline\ndetail…" — the caller numbers the headlines and
  // indents the detail lines, so a step never wraps mid-phrase into a wall.
  const steps = [
    baseUrl === null
      ? "Set `VENDO_BASE_URL` in your deploy platform to this deployment's public origin\nwithout it, discovery points at the wrong origin and clients cannot find your server"
      : `Set \`VENDO_BASE_URL\` in your deploy platform\n\`${baseUrl}\` — captured earlier, already in .env.example`,
    `Point any MCP client at \`${clientBase}${MCP_MOUNT}\`\nyour users' setup page ships free at \`${MCP_MOUNT}/connect\` — copy for Claude · ChatGPT · Cursor included`,
    "Claude Code: `/plugin marketplace add runvendo/vendo` then `/plugin install vendo@vendo`",
  ];
  if (!cloudKey) steps.push(KEYLESS_SIGN_IN);
  if (serviceKey) {
    steps.push(serviceAuth
      ? `Your backend exchanges \`VENDO_SERVICE_KEY\` at \`${clientBase}${MCP_MOUNT}/token\`\nfor a 10-minute token acting as a named user — svc: attribution in the audit`
      : "Create the service key on the console's keys page (Service keys)\nit lands in the broker — exchange it at `<your tenant URL>/token`");
  }

  return {
    changes,
    routeSource: routeSource({ serverActions, auth: authWired, mcp: { serviceAuth } }),
    ...(serviceAuth ? { serviceKeyValue: generateServiceKey() } : {}),
    steps,
    envLines: posture === "broker"
      ? [
          "`VENDO_MCP_BROKER_URL=<your tenant MCP endpoint>`",
          "`VENDO_MCP_FEDERATION_SECRET=<secret>`",
        ]
      : [],
  };
}
