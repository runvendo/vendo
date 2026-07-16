import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { createRegistry, RegistryCorruptError, SLUG_PATTERN } from "./registry.mjs";

/**
 * The demos.vendo.run router — plain node:http, zero dependencies.
 *
 * Public surface:
 *   GET /            302 -> https://vendo.run
 *   GET /healthz     200 {ok, demos}
 *   GET /:id         live: 302 -> the demo's Railway domain (+ hit counter)
 *                    expired/killed: 410 branded "demo has ended" page
 *                    unknown: 404 variant of the same page
 *   Demo ids are NEVER listed publicly.
 *
 * Admin surface (Authorization: Bearer $ROUTER_ADMIN_TOKEN; 401 without,
 * 503 when the env is unset so a misdeployed router can't be driven):
 *   GET    /admin/demos       list rows
 *   POST   /admin/demos       upsert {id, url, prospect, expiresAt, killed?}
 *   PATCH  /admin/demos/:id   partial {killed?, expiresAt?, url?, prospect?}
 *   DELETE /admin/demos/:id   remove the row
 */

const CTA_URL = "https://cal.com/yousefhelal";
const HOME_URL = "https://vendo.run";
const MAX_BODY_BYTES = 64 * 1024;

/** Small self-contained branded page for ended (410) and unknown (404) demos. */
export function brandedPage({ ended }) {
  const headline = ended ? "This demo has ended" : "There's no demo here";
  const detail = ended
    ? "The interactive demo you're looking for has wrapped up — but the real thing is one call away."
    : "That link doesn't match a live demo — but seeing the real thing is one call away.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${headline} — Vendo</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f6f3;color:#16161a;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;">
<main style="max-width:26rem;padding:3rem 1.5rem;text-align:center;">
<p style="margin:0 0 1rem;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:#5457ff;font-weight:600;">Vendo demo</p>
<h1 style="margin:0 0 .75rem;font-size:1.6rem;line-height:1.25;">${headline}</h1>
<p style="margin:0 0 2rem;font-size:.95rem;line-height:1.6;color:#55555e;">${detail}</p>
<a href="${CTA_URL}" style="display:inline-block;padding:.7rem 1.4rem;border-radius:.6rem;background:#16161a;color:#f7f6f3;text-decoration:none;font-weight:600;font-size:.95rem;">Book a call</a>
<p style="margin:2rem 0 0;font-size:.8rem;color:#8a8a93;"><a href="${HOME_URL}" style="color:inherit;">vendo.run</a></p>
</main>
</body>
</html>
`;
}

function timingSafeTokenEqual(expected, received) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const isIsoDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/** Validate one admin-supplied field; returns an error string or null. */
function fieldError(field, value) {
  switch (field) {
    case "id":
      return typeof value === "string" && SLUG_PATTERN.test(value) ? null : "id must be a slug (lowercase alphanumeric with hyphens)";
    case "url":
      return typeof value === "string" && isHttpsUrl(value) ? null : "url must be an https URL";
    case "prospect":
      return typeof value === "string" && value.length > 0 ? null : "prospect must be a non-empty string";
    case "expiresAt":
      return isIsoDate(value) ? null : "expiresAt must be an ISO-8601 date-time";
    case "killed":
      return typeof value === "boolean" ? null : "killed must be a boolean";
    default:
      return `unknown field: ${field}`;
  }
}

function validateFields(body, { required, optional }) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "body must be a JSON object" };
  const errors = [];
  for (const field of required) {
    errors.push(fieldError(field, body[field]));
  }
  for (const field of Object.keys(body)) {
    if (required.includes(field)) continue;
    if (!optional.includes(field)) {
      errors.push(`unknown field: ${field}`);
      continue;
    }
    errors.push(fieldError(field, body[field]));
  }
  const failed = errors.filter((error) => error !== null);
  return failed.length > 0 ? { error: failed.join("; ") } : { ok: true };
}

export function createRouterServer({
  registry,
  adminToken,
  log = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date(),
}) {
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      respondJson(response, 500, { error: "internal error" });
      log(`[router] unhandled error on ${request.method} ${request.url}: ${error?.stack ?? error}`);
    });
  });

  function respond(response, status, headers, body) {
    response.writeHead(status, headers);
    response.end(body);
  }

  const respondJson = (response, status, body) =>
    respond(response, status, { "Content-Type": "application/json; charset=utf-8" }, `${JSON.stringify(body)}\n`);

  const respondPage = (response, status) =>
    respond(
      response,
      status,
      { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      brandedPage({ ended: status === 410 }),
    );

  async function handle(request, response) {
    const started = Date.now();
    const url = new URL(request.url ?? "/", "http://router.invalid");
    const pathname = url.pathname;
    response.on("finish", () => {
      log(`${now().toISOString()} ${request.method} ${pathname} ${response.statusCode} ${Date.now() - started}ms`);
    });

    if (pathname === "/admin/demos" || pathname.startsWith("/admin/demos/")) {
      return handleAdmin(request, response, pathname);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return respondJson(response, 405, { error: "method not allowed" });
    }

    if (pathname === "/healthz") {
      try {
        return respondJson(response, 200, { ok: true, demos: registry.count() });
      } catch (error) {
        if (error instanceof RegistryCorruptError) return respondJson(response, 200, { ok: false, demos: 0 });
        throw error;
      }
    }

    if (pathname === "/") {
      return respond(response, 302, { Location: HOME_URL }, undefined);
    }

    const id = pathname.slice(1);
    if (!SLUG_PATTERN.test(id)) return respondPage(response, 404);

    const route = registry.routeFor(id, now());
    switch (route.kind) {
      case "live":
        registry.recordHit(id); // best-effort; never blocks the redirect
        return respond(response, 302, { Location: route.url, "Cache-Control": "no-store" }, undefined);
      case "expired":
      case "killed":
        return respondPage(response, 410);
      default:
        return respondPage(response, 404);
    }
  }

  async function handleAdmin(request, response, pathname) {
    if (adminToken === undefined || adminToken === "") {
      return respondJson(response, 503, { error: "ROUTER_ADMIN_TOKEN is not configured" });
    }
    const header = request.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !timingSafeTokenEqual(adminToken, header.slice("Bearer ".length))) {
      return respondJson(response, 401, { error: "unauthorized" });
    }

    const suffix = pathname === "/admin/demos" ? undefined : pathname.slice("/admin/demos/".length);
    if (suffix !== undefined && !SLUG_PATTERN.test(suffix)) {
      return respondJson(response, 404, { error: "unknown demo" });
    }

    try {
      if (request.method === "GET" && suffix === undefined) {
        return respondJson(response, 200, { demos: registry.list() });
      }

      if (request.method === "POST" && suffix === undefined) {
        const body = await parseJsonBody(request, response);
        if (body === undefined) return undefined;
        const validated = validateFields(body, {
          required: ["id", "url", "prospect", "expiresAt"],
          optional: ["killed"],
        });
        if (validated.error !== undefined) return respondJson(response, 400, { error: validated.error });
        return respondJson(response, 200, registry.upsert(body));
      }

      if (request.method === "PATCH" && suffix !== undefined) {
        const body = await parseJsonBody(request, response);
        if (body === undefined) return undefined;
        const validated = validateFields(body, { required: [], optional: ["killed", "expiresAt", "url", "prospect"] });
        if (validated.error !== undefined) return respondJson(response, 400, { error: validated.error });
        const patched = registry.patch(suffix, body);
        if (patched === undefined) return respondJson(response, 404, { error: "unknown demo" });
        return respondJson(response, 200, patched);
      }

      if (request.method === "DELETE" && suffix !== undefined) {
        if (!registry.remove(suffix)) return respondJson(response, 404, { error: "unknown demo" });
        return respond(response, 204, {}, undefined);
      }

      return respondJson(response, 405, { error: "method not allowed" });
    } catch (error) {
      if (error instanceof RegistryCorruptError) {
        return respondJson(response, 500, { error: "registry is corrupt — failing closed; inspect the registry file" });
      }
      throw error;
    }
  }

  async function parseJsonBody(request, response) {
    try {
      return JSON.parse(await readBody(request));
    } catch {
      respondJson(response, 400, { error: "body must be valid JSON" });
      return undefined;
    }
  }

  return server;
}

// Entrypoint: `node server.mjs` (the Dockerfile CMD). Importing this module
// from tests does NOT start a listener.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = createRegistry();
  const port = Number(process.env.PORT ?? 8080);
  const server = createRouterServer({ registry, adminToken: process.env.ROUTER_ADMIN_TOKEN });
  server.listen(port, () => {
    process.stdout.write(`[router] listening on :${port} (registry: ${process.env.REGISTRY_PATH ?? "/data/registry.json"})\n`);
  });
}
