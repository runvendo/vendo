import { UPLOAD_HEADER, VendoError } from "@vendoai/core";
import { overCap } from "../user-files.js";
import { json, route, type RouteEntry } from "./shared.js";

/** The drawer's law — its cap and the refusal that names it — lives with the
    drawer, because `vendo_user_files_put` is a second door onto the same bytes
    and the two must refuse identically. Still named here: this is the door the
    default describes. */
export { UPLOAD_MAX_BYTES } from "../user-files.js";

/**
 * The drop door: one file, raw bytes, into the caller's own drawer.
 *
 * The body IS the file — no multipart, so nothing has to be parsed back out of
 * it and the name rides the query string instead. Being a raw body also puts
 * this door outside the wire's json-mutation CSRF floor (server.ts), which is
 * why it requires {@link UPLOAD_HEADER} instead; the header's own docblock is
 * where that reasoning lives.
 */
export const fileRoutes: RouteEntry[] = [
  route("POST", "/files", async ({ request, url, deps, context }) => {
    if (request.headers.get(UPLOAD_HEADER) === null) {
      throw new VendoError("validation", `POST /files requires the ${UPLOAD_HEADER} header; use the Vendo client's files.upload().`);
    }
    const name = url.searchParams.get("name");
    if (name === null) {
      throw new VendoError("validation", "POST /files needs the file's name: ?name=<percent-encoded filename>");
    }
    const ctx = await context("chat");
    const { uploadMaxBytes: max, files: venue } = deps;
    // Refuse on the DECLARED length before reading, so an over-cap upload is
    // not held in memory to be measured. A body without one (chunked) still
    // has to be read, so the post-read check below stays the real bound.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > max) throw overCap(name, declared, max, venue);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > max) throw overCap(name, bytes.byteLength, max, venue);
    const contentType = request.headers.get("content-type");
    return json(await deps.harness.putUserFile({
      principal: ctx.principal,
      name,
      content: bytes,
      ...(contentType === null ? {} : { contentType }),
    }));
  }),
];
