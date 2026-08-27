import { dirname, join, relative, resolve, sep } from "node:path";
import { applyJudgment, disabledReason, judgmentsFileSchema, overridesFileSchema, toolsFileSchema } from "@vendoai/actions";
import {
  extractServerActions,
  serverActionRegistrations,
  type ServerActionRegistration,
} from "@vendoai/actions/sync";
// Relative (not the #dev-creds condition): the CLI is Node-only and the edge
// condition would resolve the browser-safe half here.
import type { EnvKeyProvider } from "../dev-creds/resolve.js";
import { AUTH_FAMILY_INFO, AUTH_PRESET_SPECIFIER, JWT_SECRET_ENV, type AuthWire } from "./init-auth.js";
import { appDirectory, readOptional } from "./shared.js";

/** The wired preset line plus its escape-hatch comment. The lead-in stays
    honest about how the preset got here: detection cites the found
    dependency, a chosen one says "Selected".

    `hoisted` binds the preset to a module-scope `const auth` instead of writing
    the config key inline — what the agent-loop arm needs, where the resolver
    this module exports has to reach the SAME instance the wire composed.

    The hand-written seam ("write my own") is not a call, so it takes the same
    road the anonymous composition does: `authOwnSeamLines`, through the one
    `auth:` door. */
export function authConfigLines(auth: Exclude<AuthWire, { kind: "custom" }>, hoisted = false): string {
  const name = auth.kind === "jwt" ? "jwt" : auth.preset;
  const origin = auth.kind === "jwt"
    ? "Selected your own JWT scheme"
    : auth.dependency === undefined
      ? `Selected ${AUTH_FAMILY_INFO[auth.preset].name}`
      : `Detected ${auth.dependency}`;
  const call = auth.kind === "jwt"
    ? `jwt({ secret: () => process.env.${JWT_SECRET_ENV} })`
    : `${name}()`;
  const pad = hoisted ? "" : "  ";
  return `${pad}// ${origin} — ${name}() fills the identity seams\n` +
    `${pad}// (request→user, actAs, door OAuth); options and the per-seam escape\n` +
    `${pad}// hatch: https://docs.vendo.run/howto/auth.\n` +
    (hoisted ? `const auth = ${call};\n` : `  auth: ${call},\n`);
}

/**
 * The "write my own" seam: the smallest identity object that actually BOOTS and
 * opens the MCP door — a fixed dev subject for `principal`, and a pass-through
 * `oauth` that hands the door back whatever subject it is given (the two-seam
 * shape tests/theme-seam.test.ts drives a real MCP client through). Everything
 * else on the `auth` object is optional.
 *
 * Written through the SAME one door `anonymousPrincipalLines` uses — it is that
 * block plus the `oauth` half — so a host that later adds `facts`, `memberships`
 * or `actAs` adds a member here rather than learning a second config shape.
 *
 * A fixed subject means every caller is the SAME person, so the marker rides in
 * the file itself and not in a summary line nobody re-reads.
 */
export function authOwnSeamLines(typescript: boolean, hoisted = false): string {
  // Same rule as anonymousPrincipalLines: `as const` narrows kind to the
  // Principal literal in TypeScript and is a SyntaxError in a .mjs file.
  const kind = typescript ? `"user" as const` : `"user"`;
  const subject = typescript ? "subject: string" : "subject";
  const pad = hoisted ? "" : "  ";
  const body = `${pad}  principal: async () => ({ kind: ${kind}, subject: "dev-user" }),\n` +
    `${pad}  oauth: {\n` +
    `${pad}    session: async () => ({ subject: "dev-user" }),\n` +
    `${pad}    principal: async (${subject}) => ({ kind: ${kind}, subject }),\n` +
    `${pad}  },\n`;
  return `${pad}// Your own sign-in, as the two seams Vendo reads: who a request acts as,\n` +
    `${pad}// and who the MCP door resolves a subject to. Both answer the same fixed\n` +
    `${pad}// dev subject today, so EVERY caller is the same person.\n` +
    `${pad}// replace before production — swap both bodies for your real session\n` +
    `${pad}// lookup. Facts, orgs and actAs live here too:\n` +
    `${pad}// https://docs.vendo.run/howto/auth.\n` +
    (hoisted ? `const auth = {\n${body}};\n` : `${pad}auth: {\n${body}${pad}},\n`);
}

/** The identity block for whatever this run wired, through the one `auth:`
    door: a preset call, the hand-written seam, or the anonymous demo
    principal. */
function identityLines(auth: AuthWire | null, typescript: boolean, hoisted = false): string {
  if (auth === null) return anonymousPrincipalLines(typescript);
  return auth.kind === "custom" ? authOwnSeamLines(typescript, hoisted) : authConfigLines(auth, hoisted);
}

/** The anonymous-composition identity block (no auth preset wired), written
    through the ONE DOOR `auth:` takes by hand — the same key a preset fills, so
    the host who later adds `facts`, `memberships` or the door's `oauth` adds a
    member to this object instead of learning a second config shape.

    The subject matches the demo principal both existing-agents quickstarts set
    in their chat routes — the wire route MUST resolve the same subject as the
    host's agent loop, or every app/approval created in chat is invisible to
    the embeds, which call this route directly (0.4.1 E2E cert blocker B4:
    a `() => null` wire against a demo-user chat route rendered an infinite
    skeleton). Replaced wholesale when an auth preset is wired. */
export function anonymousPrincipalLines(typescript: boolean): string {
  // `as const` narrows kind to the Principal literal in TypeScript and is a
  // SyntaxError in a .mjs file (self-serve audit B2: every plain-JS host died on
  // its first `node server.js`), so the annotation rides the host's language.
  const kind = typescript ? `"user" as const` : `"user"`;
  return `  // Who the wire's callers act as. This must resolve the SAME subject your\n` +
    `  // agent loop uses (the docs' chat routes set this demo principal), or apps\n` +
    `  // and approvals created in chat are invisible to the embeds, which call\n` +
    `  // this route directly. Replace both sides with your real session lookup.\n` +
    `  // Everything identity-shaped lives here: https://docs.vendo.run/howto/auth.\n` +
    `  auth: {\n` +
    `    principal: async () => ({ kind: ${kind}, subject: "demo-user" }),\n` +
    `  },\n`;
}

/** The preset's own import line (its own subpath, never "@vendoai/vendo/server"
    — corpus-triage Task 9: a shared barrel meant any host importing the
    server entry statically re-resolved every preset's optional peer dep,
    even unused ones). Empty for the anonymous composition and for the
    hand-written seam, which imports nothing. */
function authImportLine(auth: AuthWire | null): string {
  if (auth === null || auth.kind === "custom") return "";
  const name = auth.kind === "jwt" ? "jwt" : auth.preset;
  return `import { ${name} } from ${JSON.stringify(AUTH_PRESET_SPECIFIER[name])};\n`;
}

/** What each env-key provider's `models.default` line names: the AI SDK's
    DEFAULT provider instance — it reads the key straight out of the
    environment, so the scaffold never touches key material — and the flagship
    id that provider's ladder resolves (dev-creds/model.ts DEFAULT_MODELS). */
const MODEL_PROVIDERS: Record<EnvKeyProvider, { specifier: string; model: string }> = {
  anthropic: { specifier: "@ai-sdk/anthropic", model: "claude-sonnet-4-6" },
  openai: { specifier: "@ai-sdk/openai", model: "gpt-5" },
  google: { specifier: "@ai-sdk/google", model: "gemini-2.5-flash" },
};

/** The provider key init found in the host's environment at scaffold time.
 *  Env keys are CREDENTIALS and composition SELECTS the model, so a stray
 *  ANTHROPIC_API_KEY no longer picks one by itself — the explicit line has to
 *  exist in the config. Init detected the key, so init writes that line; a
 *  host that "just worked" off an ambient key keeps working. */
export interface ScaffoldModel {
  provider: EnvKeyProvider;
  /** The variable the key came from — named in the line's comment so the
      reader knows what still supplies it. */
  envVar: string;
}

function modelImportLine(model: ScaffoldModel | null): string {
  if (model === null) return "";
  return `import { ${model.provider} } from ${JSON.stringify(MODEL_PROVIDERS[model.provider].specifier)};\n`;
}

/** The `models` line inside a `createVendo({ … })` call. Emitted by exactly
    ONE scaffold per host: on Next that is the composition module, since the
    route composes nothing at all. */
function modelConfigLine(model: ScaffoldModel | null): string {
  if (model === null) return "";
  const { model: id } = MODEL_PROVIDERS[model.provider];
  return `  models: { default: ${model.provider}(${JSON.stringify(id)}) }, // ${model.envVar} supplies the key\n`;
}

/** The Next.js wire route: a THIN handler over the composition module. A route
    module may export only route handlers, so `createVendo` cannot live here —
    and everything that needs the SAME instance (the host's own agent loop, the
    origin-root discovery route) imports the one module instead of composing a
    second wire that shares none of the first one's state. */
export function routeSource(composition: string): string {
  return `// Next.js route modules may export only route handlers, so the composition\n` +
    `// lives in ${composition} — import it from anywhere that needs the SAME\n` +
    `// instance (your own agent loop, the origin-root discovery route).\n` +
    `import { nextVendoHandler } from "@vendoai/vendo/server";\n` +
    `import { vendo } from ${JSON.stringify(composition)};\n\n` +
    `export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);\n`;
}

/**
 * The agent-loop arm's identity, HOISTED out of the `createVendo` call: the
 * wire and the host's own loop read one binding, so they can never resolve
 * different subjects. Init writes the resolver because the arm cannot work
 * without it — every agent-loop host was hand-adding this one line to a file
 * init had just written.
 */
function sharedIdentity(auth: AuthWire | null): { binding: string; key: string; resolver: string } {
  if (auth !== null) {
    return {
      binding: identityLines(auth, true, true),
      key: `  auth,\n`,
      // The hand-written seam takes no Request — it answers one fixed subject —
      // so its resolver reads like the anonymous one, not like a preset's.
      resolver: auth.kind === "custom"
        ? `// Your own agent loop resolves its caller through the SAME seam the wire\n` +
          `// does — import this beside \`vendo\`.\n` +
          `export const resolvePrincipal = (_req: Request) => auth.principal();\n`
        : `// Your own agent loop resolves its caller through the SAME preset the wire\n` +
          `// does — import this beside \`vendo\`.\n` +
          `export const resolvePrincipal = (req: Request) => auth.principal(req);\n`,
    };
  }
  // No preset — the host writes the SAME `auth` object a preset would have
  // returned, so both arms hoist one `auth` binding, pass one `auth` key, and
  // read the resolver off it. The reader who later wants facts or the MCP
  // door's oauth half adds a member here rather than learning a second shape.
  return {
    // The subject matches the demo principal both existing-agents quickstarts
    // used to set in their chat routes by hand (0.4.1 E2E cert blocker B4: two
    // sides that disagree render an infinite skeleton). One binding, so they
    // cannot.
    binding: `// Who your callers act as. The wire and your own agent loop both resolve\n` +
      `// through this one object, so they can never land on different subjects —\n` +
      `// a mismatch has no error; the embeds just poll a screen nobody is shown.\n` +
      `// Replace it with your real session lookup. Facts, orgs, actAs and the MCP\n` +
      `// door's oauth half all live here too: https://docs.vendo.run/howto/auth.\n` +
      `const auth = {\n` +
      `  principal: async () => ({ kind: "user" as const, subject: "demo-user" }),\n` +
      `};\n`,
    key: `  auth,\n`,
    resolver: `// Your own agent loop resolves its caller here — import this beside \`vendo\`.\n` +
      `export const resolvePrincipal = (_req: Request) => auth.principal();\n`,
  };
}

/**
 * The Next composition module (`lib/vendo.ts`, or `src/lib/vendo.ts`) — the one
 * file that calls `createVendo`, exporting the instance the thin route, the
 * origin-root discovery route and the host's own agent loop all import.
 *
 * On the MCP arm `auth` is non-null by construction: the door mints its own
 * principals through the preset's oauth half and composition throws without
 * one, so `planMcp` blocks before it ever reaches this function (10-mcp §3).
 */
export function compositionModuleSource(options: {
  serverActions: boolean;
  auth: AuthWire | null;
  /** The provider key init found, written as the explicit `models` selection. */
  models?: ScaffoldModel | null;
  /** The MCP door (10-mcp), and whether first-party service auth is wired off
      the environment with it (local posture only). */
  mcp?: { serviceAuth: boolean };
  /** The agent-loop arm (`--use-case agent-loop`), where the host's own loop
      needs the caller: this module exports the resolver too. Off on every other
      arm — the file is shared, and an export nothing imports is noise. */
  agentLoop?: boolean;
}): string {
  const serviceAuth = options.mcp?.serviceAuth === true;
  const shared = options.agentLoop === true ? sharedIdentity(options.auth) : null;
  return modelImportLine(options.models ?? null) +
    authImportLine(options.auth) +
    `import { createVendo, guard } from "@vendoai/vendo/server";\n` +
    (options.serverActions ? `import { serverActions } from "./vendo-actions";\n` : "") +
    (serviceAuth
      ? `\n// Machine-to-machine: your backend exchanges this key plus a user id at\n` +
        `// /api/vendo/mcp/token (RFC 8693) for a 10-minute token acting as that named\n` +
        `// user — svc: attribution in the audit. The key stays in the environment.\n` +
        `const serviceKey = process.env.VENDO_SERVICE_KEY ?? "";\n`
      : "") +
    (shared === null ? "" : `\n${shared.binding}`) +
    `\nexport const vendo = createVendo({\n` +
    // The composition module is always TypeScript (it feeds a Next route).
    (shared?.key ?? identityLines(options.auth, true)) +
    modelConfigLine(options.models ?? null) +
    (options.serverActions ? `  serverActions,\n` : "") +
    `  guard: guard({ policy: {} }), // .vendo/policy.json: destructive asks, reads run\n` +
    (options.mcp === undefined
      ? ""
      : `  // The door outside agents reach, through the SAME guard-bound path your own\n` +
        `  // surface uses. Discovery derives from VENDO_BASE_URL — set it where you deploy.\n` +
        (serviceAuth
          ? `  mcp: serviceKey === "" ? true : { serviceAuth: { keys: [serviceKey] } },\n`
          : `  mcp: true,\n`)) +
    `});\n` +
    (shared === null ? "" : `\n${shared.resolver}`);
}

/** Where a Next host's composition lives: `lib/vendo.ts`, under `src/` exactly
    when the app directory is (`appDirectory`'s own rule, so the two can never
    land on different bases). */
export async function compositionModulePath(root: string): Promise<string> {
  return join(dirname(await appDirectory(root)), "lib", "vendo.ts");
}

/** Does the host map `@/*` onto the base that holds `lib/`? create-next-app
    writes exactly that, and it is the specifier every doc page uses — but the
    generated route has to COMPILE, and an alias the host never configured does
    not resolve, so the relative path is the fallback. */
async function mapsRootAlias(root: string, target: string): Promise<boolean> {
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    const raw = await readOptional(join(root, file));
    if (raw === null) continue;
    try {
      const options = (JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
      const mapped = options?.paths?.["@/*"]?.[0];
      if (mapped !== undefined && resolve(root, options?.baseUrl ?? ".", mapped.replace("*", "lib/vendo")) === target) return true;
    } catch {
      // Malformed (or comment-carrying) config — the relative specifier always resolves.
    }
  }
  return false;
}

/** How a file in `fromDir` imports the composition module. */
export async function compositionSpecifier(root: string, fromDir: string): Promise<string> {
  const target = (await compositionModulePath(root)).replace(/\.ts$/, "");
  if (await mapsRootAlias(root, target)) return "@/lib/vendo";
  const path = relative(fromDir, target).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * The server actions the runtime will actually dispatch: the host's current
 * `"use server"` surface, minus whatever a judgment or a human override
 * disabled. `vendo init` and `vendo doctor` MUST resolve the same set — a split
 * here is a nag on one side (register a tool nothing will ever call) or a false
 * green on the other. Failure degrades to none: sync reports extraction
 * problems loudly, and execution fails closed on a missing registration anyway.
 */
export async function requiredServerActions(root: string): Promise<ServerActionRegistration[]> {
  try {
    const { tools } = await extractServerActions(root);
    const vendoDir = join(root, ".vendo");
    const overrides = await readVendoFile(join(vendoDir, "overrides.json"), (value) => overridesFileSchema.parse(value).tools);
    const judgments = await readVendoFile(join(vendoDir, "judgments.json"), (value) => judgmentsFileSchema.parse(value).tools);
    // The same three-layer stack the runtime resolves — skeleton ⊕ judgments ⊕
    // overrides — so a tool this demands registration for is one the agent can
    // actually reach. A human override wins last, including a deliberate wake.
    return serverActionRegistrations(tools.filter((tool) => {
      const effective = applyJudgment(tool, judgments?.[tool.name]);
      return (overrides?.[tool.name]?.disabled ?? effective.disabled ?? false) !== true;
    }));
  } catch {
    return [];
  }
}

/**
 * Host tools this run extracted and then left off WITHOUT being asked to, each
 * with the layer that turned it off. The run that wrote them has to name them,
 * or the developer meets the hole later, as an assistant that cannot answer and
 * will not say why. Whatever the merge decided is what this reports.
 *
 * A tool the human disabled in overrides.json is left out: that decision is
 * theirs and already written down, so repeating it back on every run is the nag
 * the receipt has always refused to be.
 */
export async function disabledTools(root: string): Promise<string[]> {
  const vendoDir = join(root, ".vendo");
  const tools = await readVendoFile(join(vendoDir, "tools.json"), (value) => toolsFileSchema.parse(value).tools);
  const overrides = await readVendoFile(join(vendoDir, "overrides.json"), (value) => overridesFileSchema.parse(value).tools);
  const judgments = await readVendoFile(join(vendoDir, "judgments.json"), (value) => judgmentsFileSchema.parse(value).tools);
  return (tools ?? []).flatMap((tool) => {
    if (overrides?.[tool.name]?.disabled === true) return [];
    const reason = disabledReason(tool, judgments?.[tool.name], overrides?.[tool.name]);
    return reason === undefined ? [] : [`${tool.name} (${reason})`];
  });
}

/** A `.vendo/` file, or null when absent or malformed — both mean "no recorded
    decision", never a reason to fail the caller. */
async function readVendoFile<T>(path: string, parse: (value: unknown) => T): Promise<T | null> {
  const raw = await readOptional(path);
  if (raw === null) return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * How a route composes its server-action map. Init raises the wiring paste and
 * doctor raises E-WIRE-009 on exactly ONE of these — `"unwired"` — so the two
 * share the answer instead of each pattern-matching their own way. The scope is
 * load-bearing: an `import { serverActions } …` line with nothing inside
 * `createVendo({ … })` is NOT wiring (the tools still fail closed), and it is
 * the likeliest real state, because it is where a half-applied paste lands.
 */
export type ServerActionsWiring = "wired" | "unwired" | "unknown";

export function serverActionsWiring(source: string): ServerActionsWiring {
  const call = source.match(/createVendo\(\s*\{/);
  // Unrecognized composition: no honest paste to name, nothing honest to grade.
  if (call === null) return "unknown";
  return /(^|[\s{,])serverActions\b/.test(source.slice(source.indexOf(call[0]))) ? "wired" : "unwired";
}

/** Is this a THIN route over the composition module — the shape init writes,
    where `createVendo` lives in `lib/vendo` because a Next.js route module may
    export only handlers? The composition, not the route, is the file to grade
    for server-action wiring; without this a thin route reads as an unrecognized
    composition and doctor goes quiet on a host that is wired. `./vendo` stays
    matched: it is what earlier MCP installs wrote next to the route. */
export function importsSplitComposition(source: string): boolean {
  return /from\s+["'](?:\.\/vendo|[^"']*\blib\/vendo)["']/.test(source);
}

/** Does this route source the GENERATED map? A route that composes its own
    (a local object, an aliased import) is a shape init leaves alone, so
    neither init nor doctor may create or grade `vendo-actions.ts` for it. */
export function importsGeneratedMap(source: string): boolean {
  return /from\s+["']\.\/vendo-actions["']/.test(source);
}

/** A registration in the map's own key form. */
export function registrationKey(registration: ServerActionRegistration): string {
  return `${registration.module}#${registration.exportName}`;
}

/** Registrations an existing map does not carry. A map is compared by the keys
    it registers, never byte-for-byte: it is the developer's file from creation
    on, so their formatting, their comments, and their own extra entries are all
    legitimate — only an ABSENT key means a tool that fails closed. */
export function missingRegistrations(
  map: string,
  registrations: readonly ServerActionRegistration[],
): ServerActionRegistration[] {
  return registrations.filter((registration) => !map.includes(JSON.stringify(registrationKey(registration))));
}

/** The import specifier the map uses to reach an action module. */
function registrationSpecifier(root: string, wiringDir: string, registration: ServerActionRegistration): string {
  const target = relative(wiringDir, join(root, registration.module))
    .split(sep).join("/")
    .replace(/\.(?:tsx|ts|jsx|js)$/, "");
  return target.startsWith(".") ? target : `./${target}`;
}

/**
 * The generated server-action registration map (04-actions §1, ENG-248): the
 * wiring file imports each detected `"use server"` action module and passes
 * the map into `createVendo({ serverActions })`. Deterministic content —
 * sorted registrations, stable aliases — so re-init stays idempotent.
 */
export function serverActionsModuleSource(root: string, wiringDir: string, registrations: ServerActionRegistration[]): string {
  const header = `/**\n` +
    ` * Server-action registration map — created by \`vendo init\`, yours from here.\n` +
    ` * Init never rewrites a file you already have and compares this one only by\n` +
    ` * the keys it registers, so your edits are safe; when an action is missing,\n` +
    ` * init prints just the entries to add. createVendo dispatches server-action\n` +
    ` * tools in-process through this map; an action missing here fails closed at\n` +
    ` * execution time (no work performed).\n` +
    ` */\n`;
  if (registrations.length === 0) return `${header}export const serverActions = {};\n`;
  const imports: string[] = [];
  const entries: string[] = [];
  registrations.forEach((registration, index) => {
    const alias = `action${index}`;
    const specifier = registrationSpecifier(root, wiringDir, registration);
    imports.push(registration.exportName === "default"
      ? `import ${alias} from ${JSON.stringify(specifier)};`
      : `import { ${registration.exportName} as ${alias} } from ${JSON.stringify(specifier)};`);
    entries.push(`  ${JSON.stringify(registrationKey(registration))}: ${alias},`);
  });
  return `${header}${imports.join("\n")}\n\n` +
    `export const serverActions = {\n${entries.join("\n")}\n};\n`;
}

/** The runtime-neutral composition (`--framework custom`): plain Request →
 *  Response with env passed per call, so ONE generated module serves any
 *  Web-standard host — Cloudflare Workers, Bun, Deno, Hono, Lambda adapters.
 *  Construction is lazy (first request): the safe shape everywhere and the
 *  only legal one at Workers module scope. With a Vendo Cloud key the four
 *  infrastructure seams wire the Cloud adapters explicitly per the adapter
 *  rule (reference shape: the vendo-on-Workers field integration,
 *  2026-07-21). */
export function customServerSource(typescript: boolean, auth: AuthWire | null = null): string {
  const envType = typescript
    ? `\nexport interface VendoEnv {\n` +
      `  VENDO_API_KEY?: string;\n` +
      `  VENDO_CONSOLE_URL?: string;\n` +
      `  VENDO_BASE_URL?: string;\n` +
      `}\n`
    : "";
  const signatures = typescript
    ? {
        vendoVar: `let vendo: ReturnType<typeof createVendo> | null = null;`,
        getVendo: `(env: VendoEnv = {})`,
        handle: `(request: Request, env: VendoEnv = {}): Promise<Response>`,
      }
    : {
        vendoVar: `let vendo = null;`,
        getVendo: `(env = {})`,
        handle: `(request, env = {})`,
      };
  // One hint for both languages: `VendoTheme` widens its adjective fields, so
  // the JSON import assigns with no cast and TypeScript pastes what JavaScript
  // pastes.
  const clientHint = ` *   // in the client entry — theme.json adopts the host brand (08 §4);\n` +
    ` *   // <VendoOverlay /> is the conversation panel (opens from a trigger or a slot):\n` +
    ` *   import { VendoOverlay, VendoProvider } from "@vendoai/vendo/react";\n` +
    ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
    ` *   root.render(<VendoProvider baseUrl="/api/vendo" theme={theme}><App /><VendoOverlay /></VendoProvider>);\n`;
  return `/**\n` +
    ` * Route your runtime's requests through this module:\n` +
    ` *   // Cloudflare Workers:\n` +
    ` *   //   export default { fetch: (request, env) => handleVendoRequest(request, env) };\n` +
    ` *   // Bun / Deno / Hono / Node: serve your /api/vendo routes through\n` +
    ` *   //   handleVendoRequest(request)\n` +
    clientHint +
    ` * Deployed hosts must set VENDO_BASE_URL to their public origin\n` +
    ` * (credential forwarding fails closed without it — vendo doctor checks).\n` +
    ` */\n` +
    `import { createAnthropic } from "@ai-sdk/anthropic";\n` +
    authImportLine(auth) +
    `import { cloudConnections, cloudSandbox, cloudTools, createVendo, guard, hostedStore } from "@vendoai/vendo/server";\n` +
    envType +
    `\n${signatures.vendoVar}\n` +
    `\n/** Lazy singleton: constructed on the first request, never at module\n` +
    `    scope — Workers forbids I/O and timers there, and lazy is correct on\n` +
    `    every other runtime too. */\n` +
    `function getVendo${signatures.getVendo} {\n` +
    `  if (vendo === null) {\n` +
    `    const processEnv = globalThis.process?.env ?? {};\n` +
    `    const apiKey = env.VENDO_API_KEY ?? processEnv.VENDO_API_KEY;\n` +
    `    // The VENDO CONSOLE's origin — not your app's. Your app's public URL is VENDO_BASE_URL.\n` +
    `    const consoleUrl = (env.VENDO_CONSOLE_URL ?? processEnv.VENDO_CONSOLE_URL ?? "https://console.vendo.run").replace(/\\/+$/, "");\n` +
    `    const cloud = apiKey === undefined || apiKey === "" ? undefined : { apiKey, baseUrl: consoleUrl };\n` +
    `    vendo = createVendo({\n` +
    identityLines(auth, typescript)
      .split("\n").map((line) => (line === "" ? line : `    ${line}`)).join("\n") +
    `      guard: guard({ policy: {} }), // .vendo/policy.json: destructive asks, reads run\n` +
    `      // With a Vendo Cloud key the infrastructure seams wire the Cloud\n` +
    `      // adapters EXPLICITLY (composition decides; blocks never read the\n` +
    `      // environment). Without one, pass your own adapters here — models,\n` +
    `      // store, connections, sandbox all accept custom implementations.\n` +
    `      ...(cloud === undefined ? {} : {\n` +
    `        models: { default: createAnthropic({ apiKey: cloud.apiKey, baseURL: \`\${cloud.baseUrl}/api/v1\` })("vendo") },\n` +
    `        store: hostedStore(cloud),\n` +
    `        connections: cloudConnections(cloud),\n` +
    `        connectors: [cloudTools(cloud)],\n` +
    `        sandbox: cloudSandbox(cloud),\n` +
    `      }),\n` +
    `    });\n` +
    `  }\n` +
    `  return vendo;\n` +
    `}\n` +
    `\nexport function handleVendoRequest${signatures.handle} {\n` +
    `  return getVendo(env).handler(request);\n` +
    `}\n`;
}

export function expressServerSource(typescript: boolean, auth: AuthWire | null = null): string {
  const imports = typescript
    ? `import { once } from "node:events";\n` +
      `import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";\n` +
      `import { Readable } from "node:stream";\n`
    : `import { once } from "node:events";\n` +
      `import { Readable } from "node:stream";\n`;
  const types = typescript
    ? `\ntype ExpressRequest = IncomingMessage & { originalUrl?: string };\n` +
      `type ExpressNext = (error?: unknown) => void;\n`
    : "";
  const signatures = typescript
    ? {
        requestHeaders: `(headers: IncomingHttpHeaders): Headers`,
        absoluteUrl: `(request: ExpressRequest): string`,
        sendResponse: `(source: Response, target: ServerResponse): Promise<void>`,
        handle: `(request: ExpressRequest, response: ServerResponse): Promise<void>`,
        mountReturn: `: (request: ExpressRequest, response: ServerResponse, next: ExpressNext) => void`,
      }
    : { requestHeaders: "(headers)", absoluteUrl: "(request)", sendResponse: "(source, target)", handle: "(request, response)", mountReturn: "" };
  // getSetCookie is the only correct way to read multiple Set-Cookie headers,
  // but it is missing from older lib.dom Headers types — the TS variant casts,
  // and the JS variant must not (a cast is a SyntaxError in .mjs; self-serve
  // audit B2).
  const getSetCookieExpression = typescript
    ? `(source.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie`
    : `source.headers.getSetCookie`;
  const requestInit = typescript
    ? `  const init: RequestInit & { duplex?: "half" } = { method, headers: requestHeaders(request.headers) };\n`
    : `  const init = { method, headers: requestHeaders(request.headers) };\n`;
  const body = typescript
    ? `    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;\n`
    : `    init.body = Readable.toWeb(request);\n`;

  // One hint for both languages: `VendoTheme` widens its adjective fields, so
  // the JSON import assigns with no cast and TypeScript pastes what JavaScript
  // pastes.
  const clientHint = ` *   // in the client entry — theme.json adopts the host brand (08 §4);\n` +
    ` *   // <VendoOverlay /> is the conversation panel (opens from a trigger or a slot):\n` +
    ` *   import { VendoOverlay, VendoProvider } from "@vendoai/vendo/react";\n` +
    ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
    ` *   root.render(<VendoProvider baseUrl="/api/vendo" theme={theme}><App /><VendoOverlay /></VendoProvider>);\n`;
  return `/**\n` +
    ` * Add these wiring lines in your host:\n` +
    ` *   app.use("/api/vendo", mountVendo());\n` +
    clientHint +
    ` */\n` +
    imports +
    authImportLine(auth) +
    `import { createVendo, guard } from "@vendoai/vendo/server";\n` +
    types +
    `\nconst vendo = createVendo({\n` +
    identityLines(auth, typescript) +
    `  guard: guard({ policy: {} }), // .vendo/policy.json: destructive asks, reads run\n` +
    `});\n\n` +
    `function requestHeaders${signatures.requestHeaders} {\n` +
    `  const result = new Headers();\n` +
    `  for (const [name, value] of Object.entries(headers)) {\n` +
    `    if (Array.isArray(value)) for (const item of value) result.append(name, item);\n` +
    `    else if (value !== undefined) result.set(name, value);\n` +
    `  }\n` +
    `  return result;\n` +
    `}\n\n` +
    `function absoluteUrl${signatures.absoluteUrl} {\n` +
    `  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;\n` +
    `  const protocol = encrypted ? "https" : "http";\n` +
    `  const host = request.headers.host ?? "localhost";\n` +
    `  // Behind a trusted proxy, set VENDO_BASE_URL explicitly or validate forwarded headers in the host.\n` +
    `  return new URL(request.originalUrl ?? request.url ?? "/", \`${"${protocol}"}://${"${host}"}\`).href;\n` +
    `}\n\n` +
    `async function sendResponse${signatures.sendResponse} {\n` +
    `  target.statusCode = source.status;\n` +
    `  source.headers.forEach((value, name) => {\n` +
    `    if (name.toLowerCase() !== "set-cookie") target.setHeader(name, value);\n` +
    `  });\n` +
    `  const getSetCookie = ${getSetCookieExpression};\n` +
    `  const fallbackCookie = source.headers.get("set-cookie");\n` +
    `  const cookies = typeof getSetCookie === "function"\n` +
    `    ? getSetCookie.call(source.headers)\n` +
    `    : fallbackCookie === null ? [] : [fallbackCookie];\n` +
    `  if (cookies.length > 0) target.setHeader("set-cookie", cookies);\n` +
    `  if (source.body === null) {\n` +
    `    target.end();\n` +
    `    return;\n` +
    `  }\n` +
    `  target.flushHeaders();\n` +
    `  const reader = source.body.getReader();\n` +
    `  try {\n` +
    `    while (true) {\n` +
    `      const chunk = await reader.read();\n` +
    `      if (chunk.done) break;\n` +
    `      if (!target.write(chunk.value)) await once(target, "drain");\n` +
    `    }\n` +
    `    target.end();\n` +
    `  } finally {\n` +
    `    reader.releaseLock();\n` +
    `  }\n` +
    `}\n\n` +
    `async function handle${signatures.handle} {\n` +
    `  const method = request.method ?? "GET";\n` +
    requestInit +
    `  if (method !== "GET" && method !== "HEAD") {\n` +
    body +
    `    init.duplex = "half";\n` +
    `  }\n` +
    `  await sendResponse(await vendo.handler(new Request(absoluteUrl(request), init)), response);\n` +
    `}\n\n` +
    `export function mountVendo()${signatures.mountReturn} {\n` +
    `  return (request, response, next) => {\n` +
    `    void handle(request, response).catch(next);\n` +
    `  };\n` +
    `}\n`;
}

/** The port the host's own dev server listens on, read off its `dev` script:
    `-p`/`--port` in either spelling, or a leading `PORT=`. 3000 is the answer
    when the script says nothing — a placeholder naming a port the host does not
    serve on is worse than no placeholder, because it looks answered. */
export function devScriptPort(script: string | undefined): number {
  const flag = /(?:^|\s)(?:-p|--port)(?:[=\s]+)(\d{2,5})\b/.exec(script ?? "")?.[1];
  const env = /(?:^|\s)PORT=(\d{2,5})\b/.exec(script ?? "")?.[1];
  return Number(flag ?? env ?? 3000);
}

export async function devPort(root: string): Promise<number> {
  try {
    const manifest = JSON.parse((await readOptional(join(root, "package.json"))) ?? "{}") as { scripts?: Record<string, string> };
    return devScriptPort(manifest.scripts?.dev);
  } catch {
    return 3000;
  }
}

/** Where the host answers in dev: the value the dev-URL question prefills, and
    the illustrative line `.env.example` carries. One spelling for both. */
export const devBaseUrl = (port: number): string => `http://localhost:${port}`;

export const baseUrlLine = (port: number): string => `VENDO_BASE_URL=${devBaseUrl(port)}`;

export const vendoEnvExample = (port: number): string =>
  "# This deployment's FULL public URL — path prefix included. Nothing strips its\n" +
  "# path: every URL Vendo builds (host tool calls, login redirects, box callbacks)\n" +
  "# hangs off it.\n" +
  "#\n" +
  "# Dev is already done: `vendo init` asked where this app runs and wrote your\n" +
  "# answer to .env.local. When you DEPLOY, set VENDO_BASE_URL in your hosting\n" +
  "# platform's environment settings to the public URL — a production URL belongs\n" +
  "# in neither a committed file nor .env.local. Production fails loud without it\n" +
  "# (a credential-forwarding call errors instead of silently running\n" +
  "# unauthenticated).\n" +
  "#\n" +
  "# For reference, the dev shape:\n" +
  `${baseUrlLine(port)}\n` +
  "# Optional — the host API on another origin (default: the public URL above).\n" +
  "# VENDO_HOST_API_URL=\n" +
  "# Optional — the login page (default: {public URL}/login). May be absolute,\n" +
  "# on another domain.\n" +
  "# VENDO_LOGIN_URL=\n" +
  "# Model key — REQUIRED in production. In dev, `vendo init` can mint a free starter key instead.\n" +
  "# ANTHROPIC_API_KEY=\n";
