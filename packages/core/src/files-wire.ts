/**
 * The upload door's wire constants — in core because BOTH halves need the same
 * literal and neither may read the other's copy: `@vendoai/ui`'s client sends
 * it and `@vendoai/vendo`'s `POST /files` requires it.
 */

/**
 * The header that stands in for the CSRF floor on `POST /files`.
 *
 * The wire's one CSRF defence is that a mutation must be `application/json`
 * (server.ts), which a cross-origin form post cannot be. Every door exempt from
 * that gate pays a different toll to force a preflight: `/apps/import` refuses
 * CORS-safelisted media types, `/box/*` takes a bearer instead of a cookie.
 * Neither toll works here — an upload's Content-Type IS the file's own, and
 * real files are `text/plain`, which is safelisted, so a media-type allowlist
 * would refuse ordinary uploads and still admit the attack.
 *
 * A required CUSTOM header is the toll that does work, and it needs no secret:
 * a browser cannot set one on a cross-origin request without first winning a
 * preflight, and this wire answers no CORS preflight at all. So the drop door
 * can only be driven by same-origin code — which is the whole property, given
 * that auth here is an ambient cookie (the clerk/supabase presets) and a
 * hostile page would otherwise push files into a signed-in user's drawer.
 */
export const UPLOAD_HEADER = "x-vendo-upload";

/** What one caller may push into the drawer in one go by DEFAULT, and the same
 * number at every door into it; `createVendo({ uploadMaxBytes })` moves it. It
 * is a DOOR cap, not a storage cap: `vendo.putUserFile` is a trusted server
 * caller and is bounded by whatever backs the `files:` adapter instead. There
 * is no 413 rung — an over-cap upload is a request the caller can fix, which
 * is what `validation` already means everywhere else on this wire.
 *
 * Here beside {@link UPLOAD_HEADER} for the same reason that constant is: the
 * default is quoted by the drawer that enforces it (@vendoai/vendo) and by
 * `vendo doctor`, which reports it. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

/** What `POST /files` answers: where the file the user shared landed in their
 *  own files, and how big it was. The path is the whole handle — the message
 *  then carries a reference and never the bytes, and anything that can open the
 *  workspace can reach them again. */
export interface UploadedFile {
  path: string;
  bytes: number;
}
