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
