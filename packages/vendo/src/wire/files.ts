import { UPLOAD_HEADER, VendoError } from "@vendoai/core";
import { FILES_STORE_MAX_BYTES } from "@vendoai/store";
import { json, route, type FilesVenue, type RouteEntry } from "./shared.js";

/** What a browser may push through the drop door in one go by DEFAULT, and the
    ONLY place it is enforced; `createVendo({ uploadMaxBytes })` moves it. It is
    a DOOR cap, not a storage cap: `vendo.putUserFile` is a trusted server
    caller and is bounded by whatever backs the `files:` adapter instead. There
    is no 413 rung — an over-cap upload is a request the caller can fix, which
    is what `validation` already means everywhere else on this wire. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** Where the bytes this door ADMITS actually land, per backing. Named in the
    refusal because raising the cap is only half a fix: past 5 MiB with no
    `files:` adapter, the upload clears this door and dies at the store's own
    blob cap instead. */
const BACKING: Record<FilesVenue, string> = {
  byo: "the FilesAdapter wired at createVendo({ files })",
  store: `this deployment's store, which caps one file at ${FILES_STORE_MAX_BYTES} bytes`
    + " — wire createVendo({ files }) with a FilesAdapter (s3Files) before raising the door past it",
};

const overCap = (name: string, bytes: number, max: number, venue: FilesVenue): VendoError => new VendoError(
  "validation",
  `${JSON.stringify(name)} is ${bytes} bytes and the upload door allows at most ${max}: send a smaller file,`
    + ` or raise createVendo({ uploadMaxBytes }). These bytes land in ${BACKING[venue]}.`,
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
