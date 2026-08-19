import { UPLOAD_HEADER, VendoError } from "@vendoai/core";
import { json, route, type RouteEntry } from "./shared.js";

/** What a browser may push through the drop door in one go, and the ONLY place
    it is enforced. It is a DOOR cap, not a storage cap: `vendo.putUserFile` is
    a trusted server caller and is bounded by whatever backs the `files:`
    adapter instead. There is no 413 rung — an over-cap upload is a request the
    caller can fix, which is what `validation` already means everywhere else on
    this wire. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const overCap = (name: string, bytes: number): VendoError => new VendoError(
  "validation",
  `${JSON.stringify(name)} is ${bytes} bytes and an upload may be at most ${UPLOAD_MAX_BYTES}. Send a smaller file.`,
);

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
    // Refuse on the DECLARED length before reading, so an over-cap upload is
    // not held in memory to be measured. A body without one (chunked) still
    // has to be read, so the post-read check below stays the real bound.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) throw overCap(name, declared);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > UPLOAD_MAX_BYTES) throw overCap(name, bytes.byteLength);
    const contentType = request.headers.get("content-type");
    return json(await deps.harness.putUserFile({
      principal: ctx.principal,
      name,
      content: bytes,
      ...(contentType === null ? {} : { contentType }),
    }));
  }),
];
