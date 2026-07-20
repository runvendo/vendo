/**
 * WIRE-CONTRACT (PROVISIONAL) — the Vendo Cloud hosted-sandbox HTTP surface.
 *
 * execution-v2 Wave 5: every Cloud-side wire fact the adapter and its mock
 * rely on lives HERE, in one module, so a Cloud-side correction lands in one
 * place. Confirmed by probe against console.vendo.run (routes exist behind
 * 401); the items marked PROVISIONAL below were proposed to the Cloud session
 * on 2026-07-19 and are awaiting authoritative confirmation.
 *
 * The surface (all under `POST|DELETE {base}/api/v1/sandboxes`, key-authed
 * with a `Bearer VENDO_API_KEY` header; errors are `{error:{code,message}}`
 * envelopes; 402 = metered quota, 401 = bad key):
 *
 * - create   `POST /` body `{env, template?, egress?: string[]}` →
 *   201 `{id, url}`. `egress` PROVISIONAL: absent = unrestricted, `[]` =
 *   deny-all — mirroring the SandboxAdapter.create seam contract verbatim;
 *   deny-by-default is enforced ABOVE the seam (Wave 2 Lane E passes the
 *   grant-derived allowlist), so an absent field only ever comes from a
 *   caller that explicitly wants an unrestricted box. Flagged to Cloud.
 * - resume   `POST /resume` body `{ref, egress?: string[] | null}` →
 *   200 `{id, url}` (a NEW machine id every time). `egress` PROVISIONAL:
 *   absent = the snapshot-time policy, `null` = unrestricted, a list =
 *   REPLACE the snapshot's allowlist (SandboxResumePolicy semantics).
 * - destroy  `DELETE /{id-or-ref}` — machine ids (`m_<24>`) destroy the
 *   machine; URL-encoded snapshot refs (`vendo:snap_<40hex>`) destroy the
 *   sleeping snapshot state (PROVISIONAL: the one {id} route accepts both).
 *   404 on already-gone state (the adapter treats that as the seam's no-op).
 * - request  `POST /{id}/request` body `{method, path, headers?, body_b64}`
 *   → `{status, headers, body_b64}`, relayed into the box HARDWIRED to
 *   {@link CLOUD_BOX_PORT} — the Cloud data plane serves exactly one port
 *   per machine (public ingress `https://<id>.m.vendo.run` targets the same
 *   listener). The adapter surfaces a non-default `port` as the typed
 *   `cloud-single-port` error; the e2b adapter keeps multi-port.
 *   KNOWN CONFLICT (relayed to Cloud 2026-07-19): the in-box agent control
 *   channel rides `machine.request({ port: BOX_CONTROL_PORT })` (8811,
 *   box-agent.ts), so on Cloud the app-port plane (fn calls, schedules,
 *   wake) works while in-box agent edits raise the typed error until the
 *   relay learns to route the control port — at which point the allowed
 *   set here widens by one constant.
 * - snapshot `POST /{id}/snapshot` → `{ref}`; the source machine KEEPS
 *   RUNNING (the checkpoint is what survives, v2 seam semantics).
 * - stop     — NO pause endpoint exists (PROVISIONAL). Cloud machines sleep
 *   by snapshot-then-destroy; `machine.stop()` mints a best-effort
 *   preservation snapshot before deleting the machine so a pause never
 *   silently discards post-snapshot state.
 * - exec/files also exist server-side (`POST /{id}/exec`,
 *   `GET|PUT /{id}/files?path=`, `GET /{id}/files/list?dir=`) — adapter-
 *   private, used for live-lane bootstrap and diagnostics only.
 *
 * Lifecycle interaction: Vendo's machine lifecycle auto-sleeps an idle
 * machine after 5 minutes (snapshot → destroy, see machine-lifecycle.ts);
 * Cloud independently sweeps machines at 10 minutes idle and 24 hours max
 * age. Our sleep normally wins; when the Cloud sweep gets there first the
 * next wake resumes from the last stored snapshot ref, losing at most the
 * scratch state since it — acceptable, because the data rule keeps anything
 * durable in the Vendo store, never on the VM disk.
 */

/** The console mounts the managed-sandbox surface here
 * (apps/console/app/api/v1/sandboxes/*). */
export const CLOUD_SANDBOX_PATH = "/api/v1/sandboxes";

/** Cloud snapshot refs are provider-prefixed opaque strings
 * (`vendo:snap_<40hex>` today; opaque beyond the prefix by seam contract). */
export const CLOUD_SNAPSHOT_REF_PREFIX = "vendo:";

/** The one box port the Cloud request relay and public ingress serve. */
export const CLOUD_BOX_PORT = 8080;
