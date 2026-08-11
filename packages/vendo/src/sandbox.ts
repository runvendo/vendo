import type { SandboxAdapter, SandboxMachine, SandboxResumePolicy } from "@vendoai/apps";
import { defaultFetch, log, VendoError } from "@vendoai/core";
import { deploymentIdentityHeaders } from "./deployment-identity.js";
import { raiseCloudError } from "./cloud-console.js";
import {
  CLOUD_BOX_PORT,
  CLOUD_SANDBOX_PATH,
  CLOUD_SNAPSHOT_REF_PREFIX,
  CLOUD_SNAPSHOTS_SUBPATH,
  CONSOLE_SNAPSHOT_REF_PREFIX,
  KNOWN_REF_SCHEMES,
  UNKNOWN_REF_SCHEME,
} from "./sandbox-wire.js";

/** Same default as the e2b adapter and the retired ENG-295 broker client:
 * generous enough for a slow machine boot, small enough that a hung console
 * request can't wedge a generation forever. */
const DEFAULT_TIMEOUT_MS = 300_000;

export interface CloudSandboxOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  /** Per-request abort timeout, in milliseconds. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBytes = (data: Uint8Array | string): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

/** btoa/atob-based codecs (the console speaks base64 JSON envelopes); chunked
 * like the console's own encoder, and Buffer-free so the umbrella's server
 * surface keeps loading on edge/Worker targets. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    // Console garbage is the SERVICE misbehaving, never the caller's fault —
    // same posture as every malformed-success branch below.
    throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned invalid base64 content");
  }
}

/** The shared console error table (cloud-console.ts): 401/402 → cloud-required
 * (a meter-exhausted refusal body rides it as the crafted spec-§5 sentence),
 * wire-legal envelope codes forward as VendoErrors, and anything else —
 * unknown codes ("unavailable"), 5xx, non-JSON bodies — falls to
 * sandbox-unavailable with the server's message preserved. */
const raiseSandboxError = (response: Response): Promise<never> =>
  raiseCloudError(response, "sandbox", (_code, message) => {
    throw new VendoError("sandbox-unavailable", message);
  });

/** The adapter-minted composite snapshot ref payload (sandbox-wire.ts): the
 * console ref alone cannot serve the seam — destroy-by-ref needs the machine
 * id (the console DELETE route is machine-only), a bare resume re-applies the
 * snapshot-time allowlist, and url() needs the app's $PORT. */
interface CloudSnapshotState {
  version: 2;
  machineId: string;
  /** The console-minted ref (`vendo:snap_<40hex>`), sent back on resume. */
  ref: string;
  allowedDomains?: string[];
  /** The app's $PORT at snapshot time; the canonical box port when absent. */
  port?: number;
}

const parsePort = (env: Record<string, string>): number => {
  const port = Number(env.PORT ?? CLOUD_BOX_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : CLOUD_BOX_PORT;
};

const toBase64Url = (value: string): string =>
  encodeBase64(encoder.encode(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const encodeSnapshotRef = (state: CloudSnapshotState): string =>
  `${CLOUD_SNAPSHOT_REF_PREFIX}${toBase64Url(JSON.stringify(state))}`;

/** The scheme a ref announces itself with — what a provider mismatch is read
 * from. BOUNDED on purpose: the scheme is the only part of a caller's ref that
 * reaches a message, so an unbounded capture turns a stored ref into an error
 * as long as the ref itself. Nothing this long is a URI scheme, and a ref that
 * leads with one is not a reference at all. */
const REF_SCHEME_PATTERN = /^([a-z0-9][a-z0-9+.-]{0,31}):/;

/** The other providers' schemes, with the adapter that resumes one, so a
 * cross-provider ref can name the fix instead of the failure. */
const FOREIGN_PROVIDERS: Record<string, { name: string; adapter: string }> = {
  e2b: { name: "e2b", adapter: "e2bSandbox()" },
};

/** The console-minted artifact id a composite carries (sandbox-wire.ts). A
 * SHAPE check, not a prefix check: CONSOLE_SNAPSHOT_REF_PREFIX ("vendo:") is a
 * strict prefix of the composite prefix ("vendo:v2:"), so a prefix test would
 * accept a composite nested inside a composite. */
const CONSOLE_ARTIFACT_PATTERN = /^vendo:snap_[0-9a-f]{40}$/;

/** The offending value's SHAPE, never its content — a ref's payload is the
 * caller's data, and a message is a log line. */
const shapeOf = (value: unknown): string => {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length === 0 ? '""' : `a string of ${value.length} characters`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `an array of ${value.length} entries`;
  return "an object";
};

const invalidField = (field: string, expected: string, value: unknown): VendoError =>
  new VendoError(
    "validation",
    `Vendo Cloud snapshot reference has an invalid "${field}": expected ${expected}, got ${shapeOf(value)}. Rebuild the app to mint a current reference.`,
  );

/** A ref this adapter did not mint: say WHICH of the three ways it is wrong —
 * another provider's ref, a bare console artifact id, or not a reference at
 * all. One relabelling catch made all three read as the same sentence, which
 * sent every one of them down the same wrong fix. */
const notMintedHere = (snapshotRef: string): VendoError => {
  const scheme = REF_SCHEME_PATTERN.exec(snapshotRef)?.[1];
  if (scheme === undefined) {
    return new VendoError(
      "validation",
      `This is not a sandbox snapshot reference: Vendo Cloud snapshot references start with "${CLOUD_SNAPSHOT_REF_PREFIX}". Rebuild the app to mint a current reference.`,
    );
  }
  if (scheme === "vendo") {
    return new VendoError(
      "validation",
      `This is a raw Vendo Cloud artifact id, not a sandbox snapshot reference. Snapshot references start with "${CLOUD_SNAPSHOT_REF_PREFIX}" and carry the machine id alongside the artifact. Rebuild the app to mint a current reference.`,
    );
  }
  const provider = FOREIGN_PROVIDERS[scheme];
  return new VendoError(
    "validation",
    `This snapshot was minted by ${provider?.name ?? `"${scheme}"`}, but the resuming sandbox is Vendo Cloud. A snapshot cannot move between providers — resume it with the same sandbox that made it${provider === undefined ? "" : ` (pass sandbox: ${provider.adapter})`}, or rebuild the app on Cloud.`,
  );
};

const decodeSnapshotRef = (snapshotRef: string): CloudSnapshotState => {
  if (!snapshotRef.startsWith(CLOUD_SNAPSHOT_REF_PREFIX)) throw notMintedHere(snapshotRef);
  const payload = snapshotRef.slice(CLOUD_SNAPSHOT_REF_PREFIX.length);
  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(decoder.decode(Uint8Array.from(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.charCodeAt(0),
    ))) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    state = parsed as Record<string, unknown>;
  } catch {
    // The payload NEVER goes in the message — its length is what says "cut off".
    throw new VendoError(
      "validation",
      `Vendo Cloud snapshot reference is truncated or corrupt: ${payload.length} characters after the "${CLOUD_SNAPSHOT_REF_PREFIX}" prefix, expected 120-400. The stored reference was cut off — rebuild the app.`,
    );
  }
  if (state.version !== 2) throw invalidField("version", "2", state.version);
  if (typeof state.machineId !== "string" || state.machineId.length === 0) {
    throw invalidField("machineId", "a non-empty string", state.machineId);
  }
  if (typeof state.ref !== "string" || !CONSOLE_ARTIFACT_PATTERN.test(state.ref)) {
    throw invalidField("ref", 'a Vendo Cloud artifact id ("vendo:snap_<40 hex>")', state.ref);
  }
  if (state.allowedDomains !== undefined && !(Array.isArray(state.allowedDomains)
    && state.allowedDomains.every((host) => typeof host === "string"))) {
    throw invalidField("allowedDomains", "an array of hostname strings", state.allowedDomains);
  }
  if (state.port !== undefined && !(Number.isInteger(state.port)
    && (state.port as number) > 0 && (state.port as number) <= 65_535)) {
    throw invalidField("port", "an integer between 1 and 65535", state.port);
  }
  return {
    version: 2,
    machineId: state.machineId,
    ref: state.ref,
    ...(state.allowedDomains === undefined ? {} : { allowedDomains: [...state.allowedDomains as string[]] }),
    ...(state.port === undefined ? {} : { port: state.port as number }),
  };
};

/** True exactly for the "that state is already gone" answer that the seam's
 * idempotent transitions (destroy twice, stop of a dead machine) absorb. */
const isGone = (error: unknown): boolean =>
  error instanceof VendoError && error.code === "not-found";

/** Decode a ref, and report which ref failed when it will not decode.
 *
 * The decoder's message says which WAY a ref is wrong; it cannot say which
 * one, because it is one authored sentence and a ref does not belong inside
 * one. That left an operator reading "a ref was malformed" with no way to tell
 * them apart. A CLASSIFICATION of the ref reaches the `sdk_error` stream from
 * here instead (allowlisted in sdk-events.ts).
 *
 * Classification, never an echo: `resume` and `destroy` are public methods, so
 * their argument is the caller's, and a ref that failed to decode is BY
 * DEFINITION not one Vendo minted — it is arbitrary caller content, up to and
 * including a secret passed to the wrong function. A prefix of that content is
 * still that content, so the scheme is matched against the closed set above
 * and reported as the constant that matched; the rest travels only as a length.
 *
 * NOTHING here reads the whole value. There is deliberately no digest: an
 * unkeyed hash of caller content is a confirmation oracle (hash your candidate
 * secrets offline, compare), and hashing an unbounded argument on a public
 * failure path is a free CPU sink. Cross-report correlation of the same bad ref
 * is the accepted cost — do not re-add one. The error the caller sees is
 * unchanged; this only observes it on the way past. */
const decodeOrReport = (snapshotRef: string): CloudSnapshotState => {
  try {
    return decodeSnapshotRef(snapshotRef);
  } catch (error) {
    log({
      code: "vendo.snapshot-ref-undecodable",
      level: "error",
      // Vendo's OWN fixed sentence, not the decoder's. The decoder writes for
      // the CALLER and names the unrecognised scheme it read out of the ref
      // (`notMintedHere`), so relaying that sentence here would carry a
      // caller-controlled slice into telemetry. The caller still gets the full
      // sentence — it is on the error being rethrown, untouched.
      message: "[vendo] a Vendo Cloud snapshot reference could not be decoded:",
      data: {
        snapshotRefScheme: KNOWN_REF_SCHEMES.find((scheme) => snapshotRef.startsWith(scheme))
          ?? UNKNOWN_REF_SCHEME,
        snapshotRefLength: snapshotRef.length,
      },
    });
    throw error;
  }
};

/** The Cloud sandbox adapter — the OSS side of the managed-sandbox seam: the
 * execution-v2 SandboxAdapter speaking HTTP to the console's /api/v1/sandboxes
 * routes (Vendo's pooled provider capacity, metered as sandbox_minutes). The
 * wire contract — the ARTIFACT model, verified live — lives in
 * sandbox-wire.ts. Cloned from cloudConnections' shape: behavior comes ONLY
 * from constructor arguments (adapter rule — see selectSandbox in server.ts);
 * the adapter never reads the environment.
 *
 * Provider particulars, versus the e2b reference port:
 * - Snapshots are persistent artifacts that survive the machine; resume
 *   boots a NEW machine from one (fork when the source lives, wake when it
 *   is gone) and inherits NO network config, so every resume sends the
 *   applicable allowlist explicitly — the ref-recorded one bare, the
 *   caller's SandboxResumePolicy when a wake re-polices (Lane E replace
 *   semantics, native on the wire).
 * - stop() destroys the machine: Cloud has no pause, and with artifacts
 *   surviving it, snapshot-then-destroy IS the sleep semantics; previously
 *   minted refs stay valid through it (the seam law).
 * - Composite refs: the seam sees `vendo:v2:<base64url state>` carrying the
 *   console artifact ref, the source machine id (destroy-by-ref reaps a
 *   still-running source best-effort before the artifact GC), and the
 *   snapshot-time allowlist a bare resume re-applies.
 * - `spec.template` is dropped from the wire: the create route takes none —
 *   the pooled base image (Node + the in-box agent) is Cloud's own.
 *
 * `files` is part of the public seam (apps/sandbox.ts), and the console's
 * list route may answer any depth — the adapter folds it to the seam's one
 * level. The machine object also carries adapter-private exec used for
 * live-lane bootstrap and diagnostics — NOT part of the seam (the in-box agent
 * owns the inside of the box). */
export function cloudSandbox(options: CloudSandboxOptions): SandboxAdapter {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? defaultFetch;

  const send = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetchImpl(`${base}${CLOUD_SANDBOX_PATH}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        // Interaction model: key-authed Cloud requests carry the deployment
        // identity; the console meters usage from real traffic.
        ...(await deploymentIdentityHeaders()),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) await raiseSandboxError(response);
    return response;
  };

  const sendJson = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const response = await send(path, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    try {
      return await response.json();
    } catch {
      return {};
    }
  };

  const parseHandle = (payload: unknown): { id: string; url: string } => {
    const handle = payload as { id?: unknown; url?: unknown };
    if (typeof handle.id !== "string" || typeof handle.url !== "string") {
      throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no machine handle");
    }
    return { id: handle.id, url: handle.url };
  };

  const wrap = (
    handle: { id: string; url: string },
    state: { allowedDomains?: string[] | undefined; port: number },
  ): SandboxMachine => {
    const prefix = `/${encodeURIComponent(handle.id)}`;
    /** POST /{id}/snapshot — mint a persistent artifact; the source keeps running. */
    const mintArtifact = async (): Promise<string> => {
      const payload = await sendJson(`${prefix}/snapshot`, "POST") as { ref?: unknown };
      if (typeof payload.ref !== "string" || payload.ref.length === 0) {
        throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned no snapshot reference");
      }
      // A ref this adapter would itself refuse to carry must never reach a
      // document — reject it as console garbage here instead.
      if (!payload.ref.startsWith(CONSOLE_SNAPSHOT_REF_PREFIX)
        || payload.ref.length <= CONSOLE_SNAPSHOT_REF_PREFIX.length) {
        throw new VendoError("sandbox-unavailable", `Vendo Cloud sandbox returned a foreign snapshot reference (expected the "${CONSOLE_SNAPSHOT_REF_PREFIX}" prefix)`);
      }
      return payload.ref;
    };
    const remove = async (): Promise<void> => {
      try {
        await sendJson(prefix, "DELETE");
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    };
    // Seam rule: sleeping or destroying twice is not an error, and destroy is
    // final. The one-shot promises make that hold under concurrency too —
    // each transition is assigned synchronously, so racing callers share one
    // console call chain, and a destroy during an in-flight stop serializes
    // after it (e2b-adapter pattern).
    let sleeping: Promise<void> | undefined;
    let destroying: Promise<void> | undefined;

    return {
      id: handle.id,
      async request(req) {
        let payload: unknown;
        try {
          payload = await sendJson(`${prefix}/request`, "POST", {
            method: req.method,
            path: req.path.startsWith("/") ? req.path : `/${req.path}`,
            // Absent port targets the canonical box port server-side; explicit
            // ports (e.g. the in-box agent control port) route as-is.
            ...(req.port === undefined ? {} : { port: req.port }),
            ...(req.headers === undefined ? {} : { headers: req.headers }),
            ...(req.body === undefined ? {} : { body_b64: encodeBase64(toBytes(req.body)) }),
          });
        } catch (error) {
          // Wave 7 — the seam's dead-machine signal. Cloud stop is final (no
          // pause), so a conflict ("Sandbox is stopped") on the DATA path
          // means the sweep destroyed the machine out from under this handle,
          // exactly like a purged id's not-found: both become the thrown
          // not-found the lifecycle's eviction/re-wake recovery keys on.
          if (error instanceof VendoError && error.code === "conflict") {
            throw new VendoError("not-found", `Vendo Cloud sandbox ${handle.id} is gone (destroyed by the provider): ${error.message}`);
          }
          throw error;
        }
        const proxied = payload as { status?: unknown; headers?: unknown; body_b64?: unknown };
        if (typeof proxied.status !== "number" || typeof proxied.body_b64 !== "string") {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned an invalid proxy response");
        }
        const headers = typeof proxied.headers === "object" && proxied.headers !== null
          ? Object.fromEntries(Object.entries(proxied.headers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string"))
          : {};
        return { status: proxied.status, headers, body: decodeBase64(proxied.body_b64) };
      },
      async snapshot() {
        // A checkpoint through a machine object that already slept or was
        // destroyed is a caller bug — say so crisply instead of relaying
        // whatever the console answers for the dead machine.
        if (sleeping !== undefined || destroying !== undefined) {
          throw new VendoError("conflict", "the machine is asleep or destroyed; resume its snapshot ref instead of checkpointing it");
        }
        return encodeSnapshotRef({
          version: 2,
          machineId: handle.id,
          ref: await mintArtifact(),
          ...(state.allowedDomains === undefined ? {} : { allowedDomains: [...state.allowedDomains] }),
          port: state.port,
        });
      },
      async stop() {
        if (destroying !== undefined) {
          await destroying;
          return;
        }
        // Cloud sleep IS destruction: there is no pause, and snapshot
        // artifacts survive the machine — the sleep flows mint their ref
        // BEFORE stopping (machine-lifecycle.ts) and wake by resuming it.
        sleeping ??= remove();
        await sleeping;
      },
      async destroy() {
        destroying ??= (sleeping ?? Promise.resolve())
          .catch(() => undefined)
          .then(remove);
        await destroying;
      },
      files: {
        async read(path: string) {
          const response = await send(`${prefix}/files?path=${encodeURIComponent(path)}`);
          return new Uint8Array(await response.arrayBuffer());
        },
        async write(path: string, bytes: Uint8Array | string) {
          await send(`${prefix}/files?path=${encodeURIComponent(path)}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: toArrayBuffer(toBytes(bytes)),
          });
        },
        async list(dir: string) {
          const payload = await sendJson(`${prefix}/files/list?dir=${encodeURIComponent(dir)}`, "GET") as { entries?: unknown };
          const entries = Array.isArray(payload.entries)
            ? payload.entries.filter((entry): entry is string => typeof entry === "string")
            : [];
          // The seam's list is ONE level and names only; the console answers
          // whatever depth it answers, so fold the depth away here — strip the
          // listed directory back off an absolute answer, keep the first
          // segment, and a deep answer collapses onto its top-level names.
          const inside = dir.endsWith("/") ? dir : `${dir}/`;
          const names = [...new Set(entries.map((entry) => {
            const relative = entry.startsWith(inside) ? entry.slice(inside.length) : entry;
            return relative.split("/")[0] ?? "";
          }).filter((name) => name !== ""))];
          // The seam rejects for a directory the box does not hold. The console
          // route answers an empty list for BOTH an absent directory and an
          // empty one, so this reports the absent case — loud in the safe
          // direction, where answering `[]` would let a mistyped source
          // directory read as an app with no files. Narrows to the real
          // not-found when the console's list route grows one. The ROOT is the
          // exception: it exists on every box, with files or without.
          if (names.length === 0 && dir !== "" && dir !== "/") {
            throw new VendoError("not-found", `Vendo Cloud sandbox holds no directory ${dir}`);
          }
          return names;
        },
      },
      async url(port?: number) {
        // Wave 4 (layer 3) — the browser→box serving path. The handle URL
        // from create/resume IS the canonical-port ingress: single-label
        // `<id-suffix>-m.vendo.run` as shipped by the console (vendo-web
        // #85; -m is a SUFFIX because Cloudflare routes only allow leading
        // wildcards, `*-m.vendo.run/*`). Other ports insert before the
        // suffix — `<id-suffix>-<port>-m.vendo.run` — matching the
        // machine-proxy parse (sandbox-wire.ts ingress entry). Hosts
        // without a -m label (custom consoles) keep the e2b-style prefix.
        const target = port ?? state.port;
        if (target === CLOUD_BOX_PORT) return handle.url;
        const ingress = new URL(handle.url);
        const suffixed = /^(.+)-m(\..+)$/.exec(ingress.host);
        ingress.host = suffixed === null
          ? `${target}-${ingress.host}`
          : `${suffixed[1]}-${target}-m${suffixed[2]}`;
        return ingress.origin;
      },
      // ——— adapter-private below this line (live-lane bootstrap + diagnostics) ———
      async exec(cmd: string, execOptions?: { cwd?: string; timeoutMs?: number }) {
        const payload = await sendJson(`${prefix}/exec`, "POST", {
          cmd,
          ...(execOptions?.cwd === undefined ? {} : { cwd: execOptions.cwd }),
          ...(execOptions?.timeoutMs === undefined ? {} : { timeout_ms: execOptions.timeoutMs }),
        }) as { code?: unknown; stdout?: unknown; stderr?: unknown };
        if (typeof payload.code !== "number") {
          throw new VendoError("sandbox-unavailable", "Vendo Cloud sandbox returned an invalid exec response");
        }
        return {
          code: payload.code,
          stdout: typeof payload.stdout === "string" ? payload.stdout : "",
          stderr: typeof payload.stderr === "string" ? payload.stderr : "",
        };
      },
    } satisfies SandboxMachine & Record<string, unknown> as SandboxMachine;
  };

  return {
    async create(spec) {
      // spec.template is dropped: the create route takes none — the pooled
      // base image (Node + the in-box agent harness) is Cloud's own
      // (sandbox-wire.ts).
      return wrap(parseHandle(await sendJson("", "POST", {
        env: spec.env,
        // Seam semantics carried verbatim: absent = unrestricted, [] = deny-all
        // (deny-by-default lives ABOVE the seam — Lane E's grant flow).
        ...(spec.allowedDomains === undefined ? {} : { egress: [...spec.allowedDomains] }),
        // Defensive copy: later refs must record the policy the machine was
        // CREATED with, immune to caller-side mutation of the array.
      })), {
        allowedDomains: spec.allowedDomains === undefined ? undefined : [...spec.allowedDomains],
        port: parsePort(spec.env),
      });
    },
    async resume(snapshotRef, policy?: SandboxResumePolicy) {
      const state = decodeOrReport(snapshotRef);
      // The new machine inherits NO network config from the artifact
      // (sandbox-wire.ts), so every resume states the applicable allowlist:
      // Lane E's replace semantics when the caller re-polices the wake, the
      // ref-recorded snapshot-time policy otherwise. undefined stays the
      // seam's "unrestricted" (absent field on the wire).
      const allowedDomains = policy === undefined ? state.allowedDomains : policy.allowedDomains;
      return wrap(parseHandle(await sendJson("/resume", "POST", {
        ref: state.ref,
        ...(allowedDomains === undefined ? {} : { egress: [...allowedDomains] }),
      })), {
        allowedDomains: allowedDomains === undefined ? undefined : [...allowedDomains],
        port: state.port ?? CLOUD_BOX_PORT,
      });
    },
    async destroy(snapshotRef) {
      const state = decodeOrReport(snapshotRef);
      // Best-effort reap of the recorded source machine (it is usually
      // already gone — the sleep flow destroyed it), then the artifact GC.
      // A 404 from either is the seam's idempotent no-op.
      await sendJson(`/${encodeURIComponent(state.machineId)}`, "DELETE").catch(() => undefined);
      try {
        await sendJson(`${CLOUD_SNAPSHOTS_SUBPATH}/${encodeURIComponent(state.ref)}`, "DELETE");
      } catch (error) {
        if (!isGone(error)) throw error;
      }
    },
  };
}
