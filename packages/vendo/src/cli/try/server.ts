import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { toolsFileSchema, type ExtractedTool } from "@vendoai/actions";
import { DEFAULT_SSE_KEEPALIVE_INTERVAL_MS, startSseKeepalive } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { DevModelController } from "../../dev-creds/model.js";
import { runRefine, type RefineChange } from "../../refine.js";
import { createVendo, type Vendo } from "../../server.js";
import { PLAYGROUND_BUNDLE_SOURCE } from "../playground/bundle.gen.js";
import { exists } from "../shared.js";
import {
  assembleTryProfile,
  fixturesFileSchema,
  tryStageStatusSchema,
  VENDO_FIXTURES_FORMAT,
  type FixturesFile,
  type TryProfile,
  type TryStageStatus,
} from "./profile.js";
import { createSyntheticFetch } from "./synthetic-fetch.js";

/**
 * The local HTTP server behind `npx vendo try` (unified try surface, Task 5).
 *
 * The LATENCY LAW: the first paint never gates on AI. `/`, `/playground.js`,
 * `/profile.json`, and `/events` serve from disk state and in-process memory
 * alone — no model call, no network, no browser launch, no child process. The
 * model only ever matters on turns the USER starts — `/api/vendo` chat and
 * `POST /api/refine` corrections (Task 11) — and the `liveChat`/`refine`
 * capabilities the profile reports come from ONE model resolution at startup
 * that never fails the server (a keyless machine still paints everything).
 *
 * The ZERO-COMMIT GUARANTEE (extends Task 2's): every byte this server writes
 * lands under `profileRoot` — the composed vendo store's PGlite data dir is
 * pinned there explicitly (never the process cwd `createStore` would default
 * to), `profileDir: profileRoot` points every `.vendo/` read/capture at the
 * same root, and approved refine changes are written back to the profile
 * root's `.vendo/` files only. The host repo stays read-only.
 */

/** One event on the try surface's deepening stream. Task 6 (the deepening
 *  orchestrator) emits `{ type: "stage", stage, status }` through this shape;
 *  the schema deliberately stays open for additive event kinds. */
export interface TryEvent {
  type: string;
  [key: string]: unknown;
}

/** The deepening event bus — the seam between the orchestrator (Task 6, the
 *  emitter) and this server (the SSE relay + profile stage overrides). */
export interface TryEventBus {
  emit(event: TryEvent): void;
  /** Returns the unsubscribe function. */
  subscribe(subscriber: (event: TryEvent) => void): () => void;
  /** Latest-known state for late subscribers: the newest event per replay key
   *  (`type`, plus the stage for stage events), in emission order. */
  replay(): TryEvent[];
  /** The latest stage statuses seen on the stream — the live overrides
   *  `assembleTryProfile` applies over its disk-derived defaults. */
  stages(): Record<string, TryStageStatus>;
}

export function createTryEventBus(): TryEventBus {
  const latest = new Map<string, TryEvent>();
  const stageStatuses: Record<string, TryStageStatus> = {};
  const subscribers = new Set<(event: TryEvent) => void>();
  return {
    emit(event) {
      const key = typeof event["stage"] === "string" ? `${event.type}:${event["stage"]}` : event.type;
      // Delete-then-set so a superseding event moves to the tail: replay stays
      // in true emission order even when a stage's status changes.
      latest.delete(key);
      latest.set(key, event);
      if (event.type === "stage" && typeof event["stage"] === "string") {
        const status = tryStageStatusSchema.safeParse(event["status"]);
        if (status.success) stageStatuses[event["stage"]] = status.data;
      }
      for (const subscriber of [...subscribers]) subscriber(event);
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    replay: () => [...latest.values()],
    stages: () => ({ ...stageStatuses }),
  };
}

/** The wire mount and the boot object the surface app reads off `window`. */
const API_BASE = "/api/vendo";
const TRY_BOOT = JSON.stringify({ profileUrl: "/profile.json", eventsUrl: "/events", apiBase: API_BASE });

export interface StartTryServerOptions {
  /** The Task-2 profile root (`assembleTryProfile` boots from it) — also the
   *  ONE directory this server may write under. */
  profileRoot: string;
  /** The host repo the profile was extracted from; model detection resolves
   *  provider modules against it. Never written to. */
  repoRoot?: string;
  /** 0 (the default) asks the OS for a free port. */
  port?: number;
  venue?: "local";
  brand?: Partial<TryProfile["brand"]>;
  /** Explicit capability flags win over detection. Detected defaults:
   *  `liveChat` = a model resolved; `refine` = a model resolved AND the
   *  profile root has `.vendo/tools.json` (runRefine's hard input). */
  capabilities?: { liveChat?: boolean; refine?: boolean };
  /** BYO model, threaded into the vendo composition; also flips liveChat on. */
  model?: LanguageModel;
  /** Share a bus with the deepening orchestrator (Task 6); default fresh. */
  events?: TryEventBus;
  /** Test seams. */
  env?: Record<string, string | undefined>;
  heartbeatIntervalMs?: number;
}

export interface TryServer {
  url: string;
  port: number;
  events: TryEventBus;
  close(): Promise<void>;
}

/** Fail-soft artifact read, mirroring assembleTryProfile's posture: a missing
 *  or malformed file degrades to `fallback`, never a throw. */
async function readProfileArtifact<Value>(
  path: string,
  parse: (raw: string) => Value,
  fallback: Value,
): Promise<Value> {
  try {
    return parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Compose the real vendo instance the try server mounts under /api/vendo:
 * the profile root as `profileDir`, the synthetic fetch answering host route
 * calls from the profile's tools.json + fixtures.json, and an EXPLICIT store.
 *
 * The store is pinned to `<profileRoot>/.vendo/try-store` — never left to
 * `createStore`'s cwd-relative `.vendo/data` default (the zero-commit
 * guarantee), and deliberately NOT `<profileRoot>/.vendo/data` either: the
 * extraction artifacts (data/extract/*.json) already live there, and PGlite
 * initializes its data directory expecting to own it.
 *
 * Composition includes the store's schema probe so a corrupt profile root
 * fails HERE (the server's 503 lane) instead of surfacing as an opaque 500 on
 * the first wire request.
 */
export async function composeTryVendo(options: {
  profileRoot: string;
  model?: LanguageModel;
}): Promise<Vendo> {
  const vendoDir = join(options.profileRoot, ".vendo");
  const tools = await readProfileArtifact<ExtractedTool[]>(
    join(vendoDir, "tools.json"),
    (raw) => {
      // v3 from today's extraction, v1 from a legacy carried-over profile.
      const parsed = JSON.parse(raw) as unknown;
      return toolsFileSchema.parse(parsed).tools;
    },
    [],
  );
  const fixtures = await readProfileArtifact<FixturesFile>(
    join(vendoDir, "data", "extract", "fixtures.json"),
    (raw) => fixturesFileSchema.parse(JSON.parse(raw)),
    { format: VENDO_FIXTURES_FORMAT, fixtures: {} },
  );
  const store = createStore({
    dataDir: join(vendoDir, "try-store"),
    // The try store is a throwaway demo database inside a temp profile root;
    // dev-mode plaintext is the honest posture (02-store §4).
    allowUnencryptedSecrets: true,
  });
  // Task 2's carry-over (extract.ts's runDeterministicPass) always TRIES to
  // leave a policy.json here — the host's own, or an honest permissive demo
  // one — so the guard reads it from THIS explicit absolute path (never the
  // package's CWD-relative ".vendo/policy.json" default, which would answer
  // for the wrong directory entirely under `npx vendo try`). Passing this
  // object form is what flips the guard's reported posture off
  // "unconfigured" — the "Vendo is running without a policy" banner reads
  // that posture, not file presence directly. BUT: only when the file is
  // actually THERE — an explicit `policy.file` that doesn't exist makes
  // readPolicyFile throw instead of degrading like the unset default does
  // (its ENOENT fallback is `!explicit` only), so a degraded carry-over
  // (write failed) must fall through to the honest "unconfigured" posture
  // rather than turning every /api/vendo request into a 503.
  const policyPath = join(vendoDir, "policy.json");
  const vendo = createVendo({
    profileDir: options.profileRoot,
    fetch: createSyntheticFetch({ tools, fixtures }),
    store,
    ...(await exists(policyPath) ? { policy: { file: policyPath } } : {}),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  try {
    await vendo.store.ensureSchema();
  } catch (error) {
    await vendo.store.close().catch(() => undefined);
    throw error;
  }
  return vendo;
}

/** The ONE startup model resolution behind both capability flags AND the
 *  turns that need a model (`/api/vendo` chat, `POST /api/refine`): a passed
 *  model wins; otherwise the shared dev-credential ladder (DevModelController
 *  — the same resolver init, doctor, and createVendo ride; the retired
 *  `vendo refine` command rode it too). A resolution failure means `null` —
 *  honest false capabilities, never a failed server. */
async function resolveTryModel(options: StartTryServerOptions): Promise<LanguageModel | null> {
  if (options.model !== undefined) return options.model;
  try {
    const controller = new DevModelController({
      root: options.repoRoot ?? options.profileRoot,
      env: options.env ?? process.env,
    });
    const resolution = await controller.resolve();
    if (resolution.mode === "unavailable") return null;
    // The controller's own model, not the raw provider one the resolution
    // carries: only that path reaches the surface with the fix for the rung a
    // rejected key was rejected on (dev-creds/model).
    return controller.model();
  } catch {
    return null;
  }
}

function pageHtml(): string {
  // The playground shell (playground.ts pageHtml) plus the try boot object:
  // one small serialized script the surface app (Tasks 8-10) reads to find the
  // profile, the deepening stream, and the wire mount.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Vendo Try</title>
</head>
<body>
<div id="root"></div>
<script>window.__VENDO_TRY__ = ${TRY_BOOT};</script>
<script src="/playground.js?v=${PLAYGROUND_BUNDLE_SOURCE.length.toString(36)}"></script>
</body>
</html>
`;
}

/** Minimal node-http → fetch adapter for the mounted wire handler, modeled on
 *  the integrator-written one in corpus/hosts/express-host (stream the request
 *  body, preserve method/headers, write back status/headers/body — set-cookie
 *  via getSetCookie so multiple cookies survive). Local because the umbrella
 *  ships no Node server adapter of its own (hosts bring their framework's). */
async function serveWireRequest(
  vendo: Vendo,
  request: IncomingMessage,
  response: ServerResponse,
  fallbackHost: string,
): Promise<void> {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  }
  const url = new URL(request.url ?? "/", `http://${headers.get("host") ?? fallbackHost}`);
  const method = (request.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  const wireResponse = await vendo.handler(new Request(url, init));
  response.statusCode = wireResponse.status;
  wireResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") response.setHeader(name, value);
  });
  const cookies = wireResponse.headers.getSetCookie();
  if (cookies.length > 0) response.setHeader("set-cookie", cookies);
  if (wireResponse.body === null) {
    response.end();
    return;
  }
  // Pipeline preserves streaming backpressure; SSE/stream chunks never buffer.
  await pipeline(Readable.fromWeb(wireResponse.body as import("node:stream/web").ReadableStream), response);
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

/** Buffer + parse a JSON request body (the refine endpoints' tiny payloads —
 *  a 1 MiB cap keeps a hostile local client from ballooning memory). Throws
 *  on overflow or malformed JSON; callers answer 400. */
async function readJsonBody(request: IncomingMessage, limitBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The review card's one-line summary. Keyed on the artifact the change
 *  targets — RefineChange carries a diff and warnings but no prose of its
 *  own, and the target file IS the taxonomy (refine.ts's doc block). */
function refineChangeSummary(path: string): string {
  // overrides.json is the ONE authored file — corrections plus any new
  // compound capabilities and playbooks all land in it.
  if (path.endsWith("overrides.json")) return "Tool corrections and new capabilities (risk labels, enable/disable, descriptions, compounds)";
  if (path.endsWith("brief.md")) return "Product brief update";
  return `Update ${path}`;
}

type MountState = { vendo: Vendo } | { error: string };

export async function startTryServer(options: StartTryServerOptions): Promise<TryServer> {
  const bus = options.events ?? createTryEventBus();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_SSE_KEEPALIVE_INTERVAL_MS;
  const model = await resolveTryModel(options);
  const liveChat = options.capabilities?.liveChat ?? model !== null;
  // refine (Task 11) = (model resolved) AND (tools.json present), decided once
  // at startup like liveChat: the deterministic pass writes tools.json before
  // the server ever starts, so presence never changes under a running server.
  const refine = options.capabilities?.refine
    ?? (model !== null && await exists(join(options.profileRoot, ".vendo", "tools.json")));

  // The /api/vendo mount, composed LAZILY on first use and REBUILT whenever
  // any compose-time profile read changes on disk. Chosen over a per-call
  // lazy fixtures read inside the synthetic fetch because recomposition
  // refreshes EVERY compose-time read at once (brief.md into the system
  // prompt, theme/catalog/semantics, the tool surface, the fixture rows) —
  // one freshness mechanism instead of several. The trade (in-memory thread
  // state resets on rebuild) is bounded: deepening writes each artifact once
  // per run, and durable state lives in the store, which every composition
  // shares (the PGlite handle is per-dataDir refcounted in-process). A failed
  // composition answers 503 naming the error while every other route keeps
  // painting — and is NEVER cached terminally: the next /api request retries,
  // because the failure may stem from state outside the keyed set (the store
  // directory itself, permissions), not just a keyed artifact.
  //
  // The key is one stat sweep per request over the exact compose-time read
  // set: `.vendo/` tools.json + overrides.json (the actions registry),
  // theme.json + brief.md + catalog.json (createVendo's own dotVendo reads),
  // and data/extract/fixtures.json (the synthetic fetch). design-rules.md
  // needs no recompose (createVendo re-reads it per generation), and
  // `.vendo/remixable/` pin baselines are left out deliberately (deepening
  // never writes them; sync does, before the server).
  const COMPOSE_READ_SET: readonly string[][] = [
    ["tools.json"],
    ["overrides.json"],
    ["theme.json"],
    ["brief.md"],
    ["catalog.json"],
    ["data", "extract", "fixtures.json"],
  ];
  let mount: { key: string; ready: Promise<MountState>; failed: boolean } | undefined;
  const composedStores: Vendo["store"][] = [];
  const composeKey = async (): Promise<string> => {
    const stamps = await Promise.all(COMPOSE_READ_SET.map(async (segments) => {
      try {
        const stats = await stat(join(options.profileRoot, ".vendo", ...segments));
        return `${stats.mtimeMs}:${stats.size}`;
      } catch {
        return "absent";
      }
    }));
    return stamps.join("|");
  };
  const currentMount = async (): Promise<MountState> => {
    const key = await composeKey();
    if (mount === undefined || mount.key !== key || mount.failed) {
      const superseded = mount;
      const next: { key: string; ready: Promise<MountState>; failed: boolean } = {
        key,
        failed: false,
        // The startup-resolved model (passed OR ladder) threads into every
        // composition, so chat, refine, and the capability flags all agree on
        // one resolution against one env seam.
        ready: composeTryVendo({
          profileRoot: options.profileRoot,
          ...(model === null ? {} : { model }),
        }).then(
          (vendo): MountState => {
            composedStores.push(vendo.store);
            return { vendo };
          },
          (error): MountState => {
            next.failed = true;
            return { error: error instanceof Error ? error.message : String(error) };
          },
        ),
      };
      mount = next;
      // Release the superseded composition's store instead of stranding its
      // PGlite ref until close(). Best-effort: a request still streaming on
      // the old composition loses its store mid-flight, which is the accepted
      // rebuild trade above (rebuilds coincide with deepening writes).
      if (superseded !== undefined) {
        void superseded.ready
          .then(async (state) => {
            if ("vendo" in state) {
              const index = composedStores.indexOf(state.vendo.store);
              if (index >= 0) composedStores.splice(index, 1);
              await state.vendo.store.close();
            }
          })
          .catch(() => undefined);
      }
    }
    return mount.ready;
  };

  // ---------------------------------------------------------------------
  // The refine lane (Task 11): POST /api/refine runs the SAME engine `vendo
  // refine` rides, against the TEMP profile root; POST /api/refine/apply
  // writes the approved proposals back into it. Proposed whole-file bodies
  // stay server-side in this per-run cache (the simpler-but-honest option:
  // the apply step needs the exact bytes HERE anyway, and the client only
  // ever needs the rendered diff to review) — one run cached at a time,
  // replaced by the next run, matching the one-run-at-a-time flag below.
  // ---------------------------------------------------------------------
  let refineRun: { id: string; changes: RefineChange[] } | undefined;
  let refineActive = false;
  let refineSeq = 0;

  const serveRefine = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (model === null) {
      // Honest 503: the profile reports capabilities.refine false on this
      // server, so a surface following the contract never lands here.
      json(response, {
        error: { code: "refine-unavailable", message: "no model available. Refine rides the same credential ladder as live chat" },
      }, 503);
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, { error: { code: "bad-request", message: error instanceof Error ? error.message : "invalid JSON body" } }, 400);
      return;
    }
    const message = (body as { message?: unknown } | null)?.message;
    if (typeof message !== "string" || message.trim() === "") {
      json(response, { error: { code: "bad-request", message: "body must be { message: string } with a non-empty message" } }, 400);
      return;
    }
    // One refine run at a time: runs are seconds-scale (one generateObject
    // call), so a simple flag + 409 beats a queue.
    if (refineActive) {
      json(response, { error: { code: "refine-busy", message: "a refine run is already in flight, wait for it to finish" } }, 409);
      return;
    }
    refineActive = true;
    try {
      // root = the TEMP profile root: tools.json lives there, and every
      // proposed diff targets ITS `.vendo/` files — never the host repo.
      // Deliberately NO `url`: no dev app runs behind the try surface, and
      // with the url absent the engine's probes degrade to static-only
      // checks ("validated statically") instead of fabricating live results.
      const result = await runRefine({ root: options.profileRoot, model, interview: [message.trim()] });
      refineSeq += 1;
      const runId = `run_${refineSeq}`;
      refineRun = { id: runId, changes: result.changes };
      json(response, {
        runId,
        changes: result.changes.map((change, index) => ({
          id: index,
          file: change.path,
          summary: refineChangeSummary(change.path),
          diff: change.diff,
          warnings: change.warnings,
        })),
        dropped: result.dropped,
        probes: result.probes,
      });
    } catch (error) {
      json(response, { error: { code: "refine-failed", message: error instanceof Error ? error.message : String(error) } }, 500);
    } finally {
      refineActive = false;
    }
  };

  const serveRefineApply = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(response, { error: { code: "bad-request", message: error instanceof Error ? error.message : "invalid JSON body" } }, 400);
      return;
    }
    const { runId, changeIds } = (body ?? {}) as { runId?: unknown; changeIds?: unknown };
    if (!Array.isArray(changeIds) || !changeIds.every((id) => typeof id === "number" && Number.isInteger(id))) {
      json(response, { error: { code: "bad-request", message: "body must carry changeIds: an array of change ids" } }, 400);
      return;
    }
    const run = refineRun;
    if (run === undefined || (runId !== undefined && runId !== run.id)) {
      json(response, { error: { code: "unknown-run", message: "no such refine run. Its proposals are gone, run refine again" } }, 404);
      return;
    }
    // EVERY selection is validated — ids AND write targets — before the first
    // byte is written, so a bad request can never leave a partial apply.
    const selected: Array<{ id: number; change: RefineChange; target: string }> = [];
    for (const id of changeIds as number[]) {
      const change = run.changes[id];
      if (change === undefined) {
        json(response, { error: { code: "unknown-change", message: `no change ${id} in ${run.id}` } }, 400);
        return;
      }
      const target = resolve(options.profileRoot, ...change.path.split("/"));
      // Belt-and-braces zero-commit guard: runRefine only ever proposes
      // `.vendo/…` paths, but nothing outside the profile root is writable.
      if (!target.startsWith(resolve(options.profileRoot) + sep)) {
        json(response, { error: { code: "bad-request", message: `refusing to write outside the profile root: ${change.path}` } }, 400);
        return;
      }
      selected.push({ id, change, target });
    }
    // Each write is atomic (write-then-rename: the compose-key sweep and the
    // per-request profile assembly never observe a half-written artifact),
    // but the BATCH is not — a genuine disk error mid-loop leaves the earlier
    // files applied, surfaced by route()'s 500.
    for (const { change, target } of selected) {
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.refine-${refineSeq}.tmp`;
      await writeFile(temporary, change.after, "utf8");
      await rename(temporary, target);
    }
    // The compose-key sweep picks the changed artifacts up on the next
    // /api/vendo request; /profile.json re-assembles from disk per request.
    json(response, { applied: selected.map(({ id, change }) => ({ id, file: change.path })) });
  };

  // Open SSE responses, tracked so close() can end them (an idle EventSource
  // would otherwise hold the server open forever).
  const sseClients = new Set<ServerResponse>();
  const serveEvents = (request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Node holds headers until the first body write; flush now so EventSource
    // fires `open` immediately instead of waiting on the first event or
    // heartbeat (an idle stream would otherwise sit head-less for 15s).
    response.flushHeaders();
    let unsubscribe: () => void = () => undefined;
    let stopKeepalive: () => void = () => undefined;
    let closed = false;
    const teardown = (): void => {
      closed = true;
      stopKeepalive();
      unsubscribe();
      sseClients.delete(response);
    };
    // A dead socket surfaces as a throw from write(): tear this client down
    // instead of letting the throw propagate into bus.emit (one bad client
    // must never break the emitter or its other subscribers).
    const send = (event: TryEvent): void => {
      try {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        teardown();
      }
    };
    // The SAME keepalive policy the production wire uses (core/sse-keepalive.ts):
    // one comment frame now, then one per interval of silence.
    stopKeepalive = startSseKeepalive({
      intervalMs: heartbeatIntervalMs,
      write: (frame) => {
        try {
          response.write(frame);
        } catch {
          teardown();
        }
      },
    });
    // Latest-known state first: a late subscriber paints current progress
    // immediately instead of waiting for the next emission.
    for (const event of bus.replay()) send(event);
    // A socket that died DURING the replay burst already ran teardown();
    // subscribing/registering after it would re-add a dead client.
    if (closed) return;
    unsubscribe = bus.subscribe(send);
    sseClients.add(response);
    request.once("close", teardown);
  };

  let fallbackHost = "127.0.0.1";
  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === API_BASE || path.startsWith(`${API_BASE}/`)) {
      const state = await currentMount();
      if ("error" in state) {
        // The mount degrades alone: the surface still paints from /profile.json
        // and /events; only the wire names its composition failure.
        json(response, { error: { code: "composition-failed", message: state.error } }, 503);
        return;
      }
      await serveWireRequest(state.vendo, request, response, fallbackHost);
      return;
    }
    if (path === "/api/refine" && request.method === "POST") {
      await serveRefine(request, response);
      return;
    }
    if (path === "/api/refine/apply" && request.method === "POST") {
      await serveRefineApply(request, response);
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    if (path === "/playground.js") {
      response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(PLAYGROUND_BUNDLE_SOURCE);
      return;
    }
    if (path === "/profile.json") {
      // Assembled from CURRENT disk state on every request (deepening lands
      // artifacts between requests), with the bus's live stage statuses on top.
      const profile = await assembleTryProfile(options.profileRoot, {
        venue: options.venue ?? "local",
        ...(options.brand === undefined ? {} : { brand: options.brand }),
        capabilities: { liveChat, refine },
        stages: bus.stages(),
      });
      json(response, profile);
      return;
    }
    if (path === "/events") {
      serveEvents(request, response);
      return;
    }
    if (path === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (path !== "/" && path !== "/index.html") {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(pageHtml());
  };

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        json(response, { error: { code: "internal", message } }, 500);
        return;
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      // Detach the bind-failure handler so a later runtime error is not
      // swallowed by rejecting an already-settled promise (playground.ts).
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  fallbackHost = `127.0.0.1:${port}`;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    events: bus,
    close: async () => {
      for (const client of sseClients) client.end();
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      // Every composition's store (rebuilds included): release the shared
      // PGlite handle and the composition's unref'd sweep timer.
      await Promise.all(composedStores.splice(0).map((store) => store.close().catch(() => undefined)));
    },
  };
}
