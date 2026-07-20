import { join, relative, sep } from "node:path";
import {
  extractServerActions,
  serverActionRegistrations,
  type ServerActionRegistration,
} from "@vendoai/actions";
import { AUTH_FAMILY_INFO, AUTH_PRESET_SPECIFIER, type AuthMatch } from "./init-auth.js";

/** The wired preset line plus its escape-hatch comment. The lead-in stays
    honest about how the preset got here: detection cites the found
    dependency, a picker pick says "Selected". */
export function authConfigLines(auth: AuthMatch): string {
  const origin = auth.source === "picked"
    ? `Selected ${AUTH_FAMILY_INFO[auth.preset].name}`
    : `Detected ${auth.dependency}`;
  return `  // ${origin} — ${auth.preset}() fills the identity seams\n` +
    `  // (request→user, actAs, door OAuth); options and the per-seam escape\n` +
    `  // hatch: docs/act-as-presets.md.\n` +
    `  auth: ${auth.preset}(),\n`;
}

/** The empty shared registry (one file, two consumers): `createVendo` reads it
    as `catalog` (data fields only), `<VendoRoot components={registry}>` reads
    the component references. Generated only while absent — never clobbered. */
export function registrySource(variant: "tsx" | "mjs"): string {
  const header = `/**\n` +
    ` * The Vendo component registry — generated empty by \`vendo init\`, then yours.\n` +
    ` * One file, two consumers: \`createVendo\` takes this object as \`catalog\` and\n` +
    ` * reads only the data fields (description, props, examples); <VendoRoot\n` +
    ` * components={registry}> takes the same object and reads only the component\n` +
    ` * references. There is no second map to keep in sync.\n` +
    ` *\n` +
    ` * Add entries keyed by component name, e.g.:\n` +
    ` *\n` +
    ` *   SpendingDonut: {\n` +
    ` *     component: SpendingDonut,\n` +
    ` *     description: "Spending by category. Use for where-did-my-money-go requests.",\n` +
    ` *     props: z.object({\n` +
    ` *       slices: z.array(z.object({ category: z.string(), amount: z.number() })),\n` +
    ` *     }),\n` +
    ` *     examples: ['{"slices":[{"category":"dining","amount":342.18}]}'],\n` +
    ` *   },\n` +
    ` *\n` +
    ` * (\`props\` is an optional zod schema; a schema-less entry is legal.)\n` +
    ` */\n`;
  // The type comes from @vendoai/vendo, not @vendoai/core: a host only gets
  // @vendoai/vendo (and @vendoai/ui) as a direct dependency, so under pnpm
  // strict linking @vendoai/core (transitive) doesn't resolve for the host
  // (TS2307). @vendoai/vendo's root entry already re-exports the full
  // @vendoai/core type surface (index.ts: `export type * from "@vendoai/core"`),
  // and the bare root — not /server or /react — is the neutral entry for a
  // type this file needs in both the server route and the client wrap.
  return variant === "tsx"
    ? `${header}import type { ComponentRegistry } from "@vendoai/vendo";\n\nexport const registry = {} satisfies ComponentRegistry;\n`
    : `${header}export const registry = {};\n`;
}

/** The preset's own import line (its own subpath, never "@vendoai/vendo/server"
    — corpus-triage Task 9: a shared barrel meant any host importing the
    server entry statically re-resolved every preset's optional peer dep,
    even unused ones), or empty when no preset was wired. */
function authImportLine(auth: AuthMatch | null): string {
  return auth === null ? "" : `import { ${auth.preset} } from ${JSON.stringify(AUTH_PRESET_SPECIFIER[auth.preset])};\n`;
}

export function routeSource(options: { serverActions: boolean; auth: AuthMatch | null; registrySpecifier: string }): string {
  return authImportLine(options.auth) +
    `import { createVendo, nextVendoHandler } from "@vendoai/vendo/server";\n` +
    (options.serverActions ? `import { serverActions } from "./vendo-actions";\n` : "") +
    `import { registry } from ${JSON.stringify(options.registrySpecifier)};\n` +
    `\nconst vendo = createVendo({\n` +
    (options.auth === null ? `  principal: async () => null,\n` : authConfigLines(options.auth)) +
    `  catalog: registry,\n` +
    (options.serverActions ? `  serverActions,\n` : "") +
    `  policy: {}, // .vendo/policy.json: destructive asks, reads run\n` +
    `});\n\n` +
    `export const { GET, POST, PUT, PATCH, DELETE } = nextVendoHandler(vendo);\n`;
}

/** Best-effort detection of the host's registrable server actions for the
 * wiring map. Failure degrades to no map — sync reports extraction problems
 * loudly, and runtime execution fails closed on the missing registration. */
export async function wiringServerActions(root: string): Promise<ServerActionRegistration[]> {
  try {
    const { tools } = await extractServerActions(root);
    return serverActionRegistrations(tools);
  } catch {
    return [];
  }
}

/**
 * The generated server-action registration map (04-actions §1, ENG-248): the
 * wiring file imports each detected `"use server"` action module and passes
 * the map into `createVendo({ serverActions })`. Deterministic content —
 * sorted registrations, stable aliases — so re-init stays idempotent.
 */
export function serverActionsModuleSource(root: string, wiringDir: string, registrations: ServerActionRegistration[]): string {
  const header = `/**\n` +
    ` * Server-action registration map — generated by \`vendo init\`; re-run init\n` +
    ` * when the "use server" surface changes. createVendo dispatches\n` +
    ` * server-action tools in-process through this map; an action missing here\n` +
    ` * fails closed at execution time (no work performed).\n` +
    ` */\n`;
  if (registrations.length === 0) return `${header}export const serverActions = {};\n`;
  const imports: string[] = [];
  const entries: string[] = [];
  registrations.forEach((registration, index) => {
    const alias = `action${index}`;
    const target = relative(wiringDir, join(root, registration.module))
      .split(sep).join("/")
      .replace(/\.(?:tsx|ts|jsx|js)$/, "");
    const specifier = target.startsWith(".") ? target : `./${target}`;
    imports.push(registration.exportName === "default"
      ? `import ${alias} from ${JSON.stringify(specifier)};`
      : `import { ${registration.exportName} as ${alias} } from ${JSON.stringify(specifier)};`);
    entries.push(`  ${JSON.stringify(`${registration.module}#${registration.exportName}`)}: ${alias},`);
  });
  return `${header}${imports.join("\n")}\n\n` +
    `export const serverActions = {\n${entries.join("\n")}\n};\n`;
}

export function expressServerSource(typescript: boolean, auth: AuthMatch | null = null): string {
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
  const requestInit = typescript
    ? `  const init: RequestInit & { duplex?: "half" } = { method, headers: requestHeaders(request.headers) };\n`
    : `  const init = { method, headers: requestHeaders(request.headers) };\n`;
  const body = typescript
    ? `    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;\n`
    : `    init.body = Readable.toWeb(request);\n`;

  // The client-entry hint mirrors the host's language: the TS variant needs the
  // VendoTheme cast (JSON-module literals widen to string), the JS variant must
  // not show type-only syntax a JavaScript host cannot paste.
  const registrySpecifier = typescript ? "./registry" : "./registry.mjs";
  const clientHint = typescript
    ? ` *   // in the client entry — theme.json adopts the host brand (08 §4);\n` +
      ` *   // the cast narrows TypeScript's widened JSON-module string literals:\n` +
      ` *   import { VendoRoot } from "@vendoai/vendo/react";\n` +
      ` *   import { registry } from "<path-to>/vendo/registry";\n` +
      ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
      ` *   import type { VendoTheme } from "@vendoai/vendo";\n` +
      ` *   root.render(<VendoRoot components={registry} theme={theme as VendoTheme}><App /></VendoRoot>);\n`
    : ` *   // in the client entry — theme.json adopts the host brand (08 §4):\n` +
      ` *   import { VendoRoot } from "@vendoai/vendo/react";\n` +
      ` *   import { registry } from "<path-to>/vendo/registry.mjs";\n` +
      ` *   import theme from "<path-to>/.vendo/theme.json";\n` +
      ` *   root.render(<VendoRoot components={registry} theme={theme}><App /></VendoRoot>);\n`;
  return `/**\n` +
    ` * Add these wiring lines in your host:\n` +
    ` *   app.use("/api/vendo", mountVendo());\n` +
    clientHint +
    ` */\n` +
    imports +
    authImportLine(auth) +
    `import { createVendo } from "@vendoai/vendo/server";\n` +
    `import { registry } from ${JSON.stringify(registrySpecifier)};\n` +
    types +
    `\nconst vendo = createVendo({\n` +
    (auth === null ? `  principal: async () => null,\n` : authConfigLines(auth)) +
    `  catalog: registry,\n` +
    `  policy: {}, // .vendo/policy.json: destructive asks, reads run\n` +
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
    `  const getSetCookie = (source.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;\n` +
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

export const VENDO_ENV_EXAMPLE =
  "# Trusted host origin for same-origin API calls. Dev trusts the request's own\n" +
  "# origin automatically; production fails loud without this set (a credential-\n" +
  "# forwarding call errors instead of silently running unauthenticated).\n" +
  "VENDO_BASE_URL=http://localhost:3000\n" +
  "# Model key — REQUIRED in production. In dev, `vendo init` can mint a free starter key instead.\n" +
  "# ANTHROPIC_API_KEY=\n";
