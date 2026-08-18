import { VendoError } from "@vendoai/core";
import { json, route, type RouteEntry } from "./shared.js";

/** What a browser may push through the drop door in one go, and the ONLY place
    it is enforced. It is a DOOR cap, not a storage cap: `vendo.putUserFile` is
    a trusted server caller and is bounded by whatever backs the `files:`
    adapter instead. There is no 413 rung — an over-cap upload is a request the
    caller can fix, which is what `validation` already means everywhere else on
    this wire. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The drop door: one file, raw bytes, into the caller's own drawer.
 *
 * The body IS the file — no multipart, so nothing has to be parsed back out of
 * it and the name rides the query string instead. That also settles CSRF the
 * way `/apps/import` does: the door is exempt from the wire's json-mutation
 * floor (server.ts), and a real file's media type is not CORS-safelisted, so a
 * cross-origin post has to clear a preflight first.
 */
export const fileRoutes: RouteEntry[] = [
  route("POST", "/files", async ({ request, url, deps, context }) => {
    const name = url.searchParams.get("name");
    if (name === null) {
      throw new VendoError("validation", "POST /files needs the file's name: ?name=<percent-encoded filename>");
    }
    const ctx = await context("chat");
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > UPLOAD_MAX_BYTES) {
      throw new VendoError(
        "validation",
        `${JSON.stringify(name)} is ${bytes.byteLength} bytes and an upload may be at most ${UPLOAD_MAX_BYTES}. Send a smaller file.`,
      );
    }
    const contentType = request.headers.get("content-type");
    return json(await deps.harness.putUserFile({
      principal: ctx.principal,
      name,
      content: bytes,
      ...(contentType === null ? {} : { contentType }),
    }));
  }),
];
