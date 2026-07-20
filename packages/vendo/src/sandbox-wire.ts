/**
 * WIRE-CONTRACT — the Vendo Cloud hosted-sandbox HTTP surface.
 *
 * execution-v2 Wave 5: every Cloud-side wire fact the adapter and its mock
 * rely on lives HERE, in one module, so a Cloud-side change lands in one
 * place. Authoritative per the Cloud session's from-code answers PLUS live
 * probes against prod (2026-07-19, real key): every behavior below marked
 * (probed) was observed on console.vendo.run.
 *
 * The surface (under `{base}/api/v1/sandboxes`, key-authed with a
 * `Bearer VENDO_API_KEY` header; errors are `{error:{code,message}}`
 * envelopes; 402 = metered quota, 401 = bad key):
 *
 * - create   `POST /` body `{env, files?, egress?: string[]}` →
 *   201 `{id, url}` (probed). No template field — the pooled base image is
 *   Cloud's own; the adapter drops `spec.template` and documents it.
 *   `egress` absent = unrestricted, `[]` = deny-all — mirroring the
 *   SandboxAdapter.create seam contract verbatim; deny-by-default is
 *   enforced ABOVE the seam (Wave 2 Lane E always passes the grant-derived
 *   list). The filter is HTTP(S)-only: raw TCP is severed even to
 *   allowlisted hosts (raw Postgres never works; the HTTPS store API does).
 * - snapshot `POST /{id}/snapshot` → 200 `{ref}` with ref
 *   `vendo:snap_<40hex>` (probed). A snapshot IS a state-preserving PAUSE:
 *   the machine stops serving (exec/request on a paused box = 409
 *   "Sandbox is paused", probed), and the ref revives it. Multiple
 *   snapshots per machine mint distinct refs (probed). Storage is metered
 *   (storage_gb; 402 on exhausted).
 * - resume   `POST /resume` body `{ref}` → 200 `{id, url}` reviving the
 *   SAME machine id (pause model — no fork; probed). A ref only revives a
 *   PAUSED machine: resume while it runs = 409 "Sandbox is live"; resume
 *   after the machine was deleted = 409 "Sandbox is stopped" (both
 *   probed). No egress field yet — a changed resume policy raises the
 *   typed `cloud-egress-override-unsupported` error (see resume()).
 * - destroy  `DELETE /{id}` → 200 `{ok:true}`; MACHINE ids only (a
 *   URL-encoded ref answers 404, probed); repeat-delete = 200 (probed).
 *   Deletion is terminal: the machine's snapshot refs die with it
 *   (409 "Sandbox is stopped" on resume, probed) and its snapshot rows
 *   keep metering storage_gb with no way to reclaim them yet.
 * - request  `POST /{id}/request` body `{method, path, port?, headers?,
 *   body_b64}` → `{status, headers, body_b64}`, relayed into the box.
 *   `port` absent targets the canonical box port {@link CLOUD_BOX_PORT};
 *   any 1-65535 routes (probed live — out-of-range answers a clean 400
 *   validation error), so the in-box agent control port (8811) works.
 * - exec/files also exist server-side (`POST /{id}/exec`,
 *   `GET|PUT /{id}/files?path=`, `GET /{id}/files/list?dir=`) — adapter-
 *   private, used for live-lane bootstrap and diagnostics only.
 *
 * Adapter reconstruction over the pause model:
 * - `machine.snapshot()` = snapshot (pause) + immediate resume, so the seam
 *   law "the source keeps serving after a snapshot" holds; the returned ref
 *   is the adapter-minted composite {@link CLOUD_SNAPSHOT_REF_PREFIX} +
 *   base64url(JSON {machineId, ref, allowedDomains?}) — destroy-by-ref
 *   needs the machine id (DELETE is machine-only) and resume-policy
 *   comparison needs the snapshot-time allowlist.
 * - `machine.stop()` = a bare snapshot (pause), its ref discarded — the
 *   sleep flows that need a ref mint their own first (machine-lifecycle).
 *   Each stop therefore leaks one snapshot row until follow-up (A) below.
 * - `adapter.destroy(ref)` = DELETE the encoded machine id (idempotent).
 *
 * IN-FLIGHT Cloud follow-ups (accepted, behind the tick-broker deploy —
 * "stage, don't block"):
 * - (A) `DELETE /api/v1/sandboxes/snapshots/{url-encoded ref}` → 200,
 *   404 = already gone; reclaims the paused sandbox + storage_gb. Once
 *   live, destroy-by-ref and stop() stop leaking snapshot rows.
 * - (B) `POST /resume` gains `egress?: string[]` (absent = keep the created
 *   config, list = REPLACE, [] = deny-all). Once live, resume() sends a
 *   changed policy instead of raising cloud-egress-override-unsupported
 *   (an unrestricted override — allowedDomains: undefined — still has no
 *   wire shape and keeps the typed error).
 *
 * OPEN BLOCKER (reported to the coordinator 2026-07-19, probed): because
 * refs die with their machine, the OSS machine lifecycle's sleep
 * (snapshot → destroy the source) and provision (create → snapshot →
 * destroy) leave Cloud apps UNWAKEABLE — resume answers 409. Requested
 * Cloud fix: resume of a ref whose machine is stopped/deleted provisions a
 * NEW machine from the stored snapshot row, which also restores the seam
 * laws (refs survive destroy; fork-on-resume) and the two conformance
 * cases now gated behind resumeForks.
 *
 * Lifecycle interaction: Vendo auto-sleeps an idle machine after 5 minutes;
 * Cloud independently sweeps at 10 minutes idle and 24 hours max age. Our
 * sleep normally wins; when the Cloud sweep gets there first the next wake
 * resumes from the last stored ref (once the blocker above is fixed),
 * losing at most scratch state — acceptable, because the data rule keeps
 * anything durable in the Vendo store, never on the VM disk.
 */

/** The console mounts the managed-sandbox surface here
 * (apps/console/app/api/v1/sandboxes/*). */
export const CLOUD_SANDBOX_PATH = "/api/v1/sandboxes";

/** Adapter-minted snapshot refs: this prefix + base64url(JSON state).
 * These are what the seam (and app documents) carry. */
export const CLOUD_SNAPSHOT_REF_PREFIX = "vendo:v2:";

/** Console-minted snapshot refs (`vendo:snap_<40hex>`, probed) — carried
 * INSIDE the adapter's composite ref, never handed to the seam bare. */
export const CONSOLE_SNAPSHOT_REF_PREFIX = "vendo:";

/** The canonical box port the relay targets when no port rides the wire
 * (and the one the public ingress `https://<id>.m.vendo.run` serves). */
export const CLOUD_BOX_PORT = 8080;
