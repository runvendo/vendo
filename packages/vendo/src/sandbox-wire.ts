/**
 * WIRE-CONTRACT — the Vendo Cloud hosted-sandbox HTTP surface.
 *
 * execution-v2 Wave 5: every Cloud-side wire fact the adapter and its mock
 * rely on lives HERE, in one module, so a Cloud-side change lands in one
 * place. Authoritative per the Cloud session's 2026-07-19 ship note (the
 * ARTIFACT model — persistent snapshot artifacts, verified live in prod
 * with a full snapshot → destroy → resume → fork cycle) plus this lane's
 * own live probes and conformance runs against console.vendo.run.
 *
 * The surface (under `{base}/api/v1/sandboxes`, key-authed with a
 * `Bearer VENDO_API_KEY` header; errors are `{error:{code,message}}`
 * envelopes; 402 = metered quota, 401 = bad key):
 *
 * - create   `POST /` body `{env, files?, egress?: string[]}` →
 *   201 `{id, url}`. No template field — the pooled base image is Cloud's
 *   own; the adapter drops `spec.template` and documents it. `egress`
 *   absent = unrestricted, `[]` = deny-all — mirroring the
 *   SandboxAdapter.create seam contract verbatim; deny-by-default is
 *   enforced ABOVE the seam (Wave 2 Lane E always passes the grant-derived
 *   list). The filter is HTTP(S)-only: raw TCP is severed even to
 *   allowlisted hosts (raw Postgres never works; the HTTPS store API does).
 * - snapshot `POST /{id}/snapshot` → 200 `{ref}` with ref
 *   `vendo:snap_<40hex>` — a persistent ARTIFACT of the machine's state.
 *   The source machine keeps running (and billing); artifacts survive the
 *   machine's destruction. (Cloud-side caveat, no wire impact: artifact
 *   storage meters 0 GB for now.)
 * - resume   `POST /resume` body `{ref, egress?: string[]}` → 200
 *   `{id, url}` booting a NEW machine from the artifact (a live source
 *   makes it a fork; a destroyed one a wake). BREAKING vs create-config
 *   intuition: the new machine does NOT inherit network config — `egress`
 *   absent = unrestricted (Free orgs coerce deny-all) — so the adapter
 *   sends the applicable allowlist EXPLICITLY on every resume: the
 *   ref-recorded one for a bare resume, the SandboxResumePolicy one when
 *   the caller re-polices a wake (Lane E replace semantics, native).
 *   Resume of a GC'd or pre-artifact ref answers 404.
 * - destroy  `DELETE /{id}` → 200 `{ok:true}`; MACHINE ids only (a
 *   URL-encoded ref answers 404); repeat-delete = 200. Snapshot artifacts
 *   SURVIVE the machine — sleep is snapshot-then-destroy, wake is resume.
 * - snapshot GC `DELETE /snapshots/{url-encoded ref}` → 200 `{ok:true}`,
 *   404 = already gone (treat as the seam's idempotent no-op); reclaims
 *   the artifact and its storage row.
 * - request  `POST /{id}/request` body `{method, path, port?, headers?,
 *   body_b64}` → `{status, headers, body_b64}`, relayed into the box.
 *   `port` absent targets the canonical box port {@link CLOUD_BOX_PORT}
 *   (NOT the box's $PORT — the one provider divergence the conformance
 *   multiPort flag covers); any explicit 1-65535 routes (probed — an
 *   out-of-range port answers a clean 400 validation error), so the
 *   in-box agent control port (8811) works.
 - exec/files also exist server-side (`POST /{id}/exec`,
 *   `GET|PUT /{id}/files?path=`, `GET /{id}/files/list?dir=`) — adapter-
 *   private, used for live-lane bootstrap and diagnostics only.
 * - ingress  the create/resume handle `url`
 *   (`https://<id-suffix>-m.vendo.run`, single-label scheme SHIPPED by
 *   vendo-web #85 on 2026-07-20; the -m is a SUFFIX, not a prefix —
 *   Cloudflare worker routes only allow leading wildcards, so the route is
 *   `*-m.vendo.run/*`) is the canonical-port public surface;
 *   `machine.url(port)` inserts other ports before the suffix
 *   (`https://<id-suffix>-<port>-m.vendo.run`), matching the machine-proxy
 *   parse `^([a-z0-9]{24})(?:-(port))?-m\.vendo\.run$`. Single-label hosts
 *   ride the existing `*.vendo.run` Universal SSL cert — no advanced
 *   certificate needed (live-verified 2026-07-20: TLS fails on the legacy
 *   dot shape `test123.m.vendo.run`, succeeds single-label; unknown ids
 *   answer a JSON 404). The console mints `url`, so the hostname shape is
 *   console-side; this adapter echoes whatever handle it is given.
 *
 * Adapter mapping:
 * - `machine.snapshot()` = the artifact mint, wrapped in the adapter's
 *   composite ref {@link CLOUD_SNAPSHOT_REF_PREFIX} + base64url(JSON
 *   {machineId, ref, allowedDomains?}): the machine id lets destroy-by-ref
 *   reap a still-running source, and the allowlist is what a bare resume
 *   re-applies (the wire inherits nothing).
 * - `machine.stop()` = destroy: Cloud has no pause — with artifacts
 *   surviving the machine, snapshot-then-destroy IS the sleep semantics
 *   (exactly the machine-lifecycle flow), and previously minted refs stay
 *   valid through it (the seam law).
 * - `adapter.destroy(ref)` = best-effort reap of the recorded source
 *   machine, then artifact GC.
 *
 * Lifecycle interaction: Vendo auto-sleeps an idle machine after 5 minutes
 * (snapshot → destroy); Cloud independently sweeps at 10 minutes idle and
 * 24 hours max age. Our sleep normally wins; when the Cloud sweep gets
 * there first the next wake resumes from the last stored ref, losing at
 * most scratch state since it — acceptable, because the data rule keeps
 * anything durable in the Vendo store, never on the VM disk.
 */

/** The console mounts the managed-sandbox surface here
 * (apps/console/app/api/v1/sandboxes/*). */
export const CLOUD_SANDBOX_PATH = "/api/v1/sandboxes";

/** Snapshot-artifact GC route (under {@link CLOUD_SANDBOX_PATH}). */
export const CLOUD_SNAPSHOTS_SUBPATH = "/snapshots";

/** Adapter-minted snapshot refs: this prefix + base64url(JSON state).
 * These are what the seam (and app documents) carry. */
export const CLOUD_SNAPSHOT_REF_PREFIX = "vendo:v2:";

/** Console-minted artifact refs (`vendo:snap_<40hex>`) — carried INSIDE the
 * adapter's composite ref, never handed to the seam bare. */
export const CONSOLE_SNAPSHOT_REF_PREFIX = "vendo:";

/** The canonical box port the relay targets when no port rides the wire
 * (and the one the public ingress `https://<id-suffix>-m.vendo.run`
 * serves). */
export const CLOUD_BOX_PORT = 8080;
