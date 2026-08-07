import { VendoError, canonicalJson, type VendoRecord } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";

const decoder = new TextDecoder();

export interface RecordedRequest {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  deploymentHost: string | null;
  deploymentName: string | null;
  json?: unknown;
  bytes?: Uint8Array;
}

/** In-memory fake of the console's /api/v1/store surface (the wire the
 * adapter must speak — see apps/console/lib/api/store-handlers.ts). Records
 * ride the reference memoryStoreAdapter, which already mirrors the store
 * engine's reserved-collection semantics (append-only audit, state id
 * grammar, cross-subject refusals), so parity failures surface as real
 * envelopes. Sessions mirror the console's registry doors: register == touch,
 * adopt retires the registration, stale/claim implement the host-driven
 * sweep's list and mutual-exclusion legs with the engine's idleness
 * predicate. The erase cascade itself is the console's concern (proven in the
 * console repo against real per-org engines); here it answers the wire shape
 * and records the call. */
export function fakeConsole() {
  const adapter = memoryStoreAdapter();
  const requests: RecordedRequest[] = [];
  const eraseCalls: unknown[] = [];
  const sessions = new Map<string, number>();

  /** A route this fake does not serve is a HOLE IN THE FAKE, and it throws out
   * of `fetch` so that nothing can read it as the console's own answer. It used
   * to answer `not-found`, which is exactly what a live console says when it
   * refuses — so a test driving an unserved op family saw a plausible rejection,
   * concluded the code handled it, and proved nothing. No production path makes
   * `fetch` reject with this name, so the signal cannot be mistaken for one.
   * Serve the route here, or assert this throw. */
  const unserved = (method: string, path: string, detail?: string): never => {
    const error = new Error(
      `fakeConsole does not serve ${method} ${path}`
      + `${detail === undefined ? "" : ` (${detail})`} — implement it in hosted-store.test-util.ts`,
    );
    error.name = "FakeConsoleUnservedRoute";
    throw error;
  };
  const isUnserved = (error: unknown): boolean =>
    error instanceof Error && error.name === "FakeConsoleUnservedRoute";

  const STATUS: Record<string, number> = {
    validation: 400,
    unauthorized: 401,
    blocked: 403,
    "not-found": 404,
    conflict: 409,
  };
  const json = (body: unknown, status = 200): Response => Response.json(body, { status });
  const envelope = (code: string, message: string): Response =>
    json({ error: { code, message } }, STATUS[code] ?? 503);

  const sameValue = (
    current: VendoRecord,
    expected: { data: unknown; refs?: Record<string, string> },
  ): boolean =>
    canonicalJson(current.data) === canonicalJson(expected.data)
    && canonicalJson(current.refs ?? null) === canonicalJson(expected.refs ?? null);

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const recorded: RecordedRequest = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
      contentType: request.headers.get("content-type"),
      deploymentHost: request.headers.get("x-vendo-deployment-host"),
      deploymentName: request.headers.get("x-vendo-deployment-name"),
    };
    const raw = new Uint8Array(await request.arrayBuffer());
    if (recorded.contentType === "application/json") {
      recorded.json = JSON.parse(decoder.decode(raw));
    } else if (raw.length > 0) {
      recorded.bytes = raw;
    }
    requests.push(recorded);
    if (recorded.authorization === null) {
      return envelope("unauthorized", "Valid API key required.");
    }

    try {
      const miss = (detail?: string): never => unserved(request.method, url.pathname, detail);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      // /api/v1/store/...
      if (segments[0] !== "api" || segments[1] !== "v1" || segments[2] !== "store") {
        miss("not the console's store mount");
      }
      const rest = segments.slice(3);

      // Store Wire v1 records door (STORE_WIRE_PATHS): one route per op, the
      // collection rides the body. The per-collection legacy door below keeps
      // serving the StoreAdapter surface over the same in-memory state.
      if (rest[0] === "records" && rest.length === 2 && request.method === "POST") {
        const body = recorded.json as Record<string, unknown>;
        const records = adapter.records(body.collection as string);
        switch (rest[1]) {
          case "get":
            return json({ record: await records.get(body.id as string) });
          case "put":
            return json({ record: await records.put(body.record as never) });
          case "delete":
            await records.delete(body.id as string);
            return json({ ok: true });
          case "list":
            return json(await records.list((body.query ?? {}) as never));
          case "claim": {
            const expected = body.expected as { id: string; data: unknown; refs?: Record<string, string> };
            const current = await records.get(expected.id);
            if (current === null || !sameValue(current, expected)) return json({ claimed: false });
            const replacement = body.replacement as { data: unknown; refs?: Record<string, string> } | undefined;
            if (replacement === undefined) {
              await records.delete(expected.id);
            } else {
              await records.put({
                id: expected.id,
                data: replacement.data as never,
                ...(replacement.refs === undefined ? {} : { refs: replacement.refs }),
              });
            }
            return json({ claimed: true });
          }
          case "insertIfAbsent":
            return json({ record: await records.atomic!.insertIfAbsent(body.record as never) });
          case "compareAndSwap":
            return json({
              record: await records.atomic!.compareAndSwap(
                body.record as never,
                body.expectedRevision as string,
              ),
            });
          default:
            return miss(`unknown records op: ${rest[1]}`);
        }
      }

      // Store Wire v1 blobs door: JSON POST, bytes base64 on the wire.
      if (rest[0] === "blobs" && rest.length === 2 && request.method === "POST") {
        const body = recorded.json as Record<string, unknown>;
        const blobs = adapter.blobs(body.namespace as string);
        switch (rest[1]) {
          case "put": {
            const contentType = body.contentType as string | undefined;
            await blobs.put(
              body.key as string,
              Uint8Array.from(atob(body.bytes as string), (char) => char.charCodeAt(0)),
              contentType === undefined ? undefined : { contentType },
            );
            return json({ ok: true });
          }
          case "get": {
            const blob = await blobs.get(body.key as string);
            if (blob === null) return json({ blob: null });
            let binary = "";
            for (const byte of blob.bytes) binary += String.fromCharCode(byte);
            return json({
              blob: {
                bytes: btoa(binary),
                ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
              },
            });
          }
          case "delete":
            await blobs.delete(body.key as string);
            return json({ ok: true });
          case "list":
            return json({ keys: await blobs.list((body.prefix as string | undefined) ?? "") });
          default:
            return miss(`unknown blobs op: ${rest[1]}`);
        }
      }

      if (rest[0] === "records" && request.method === "POST") {
        const collection = rest[1]!;
        const method = rest.slice(2).join("/");
        const body = recorded.json as Record<string, unknown>;
        const records = adapter.records(collection);
        switch (method) {
          case "get":
            return json({ record: await records.get(body.id as string) });
          case "put":
            return json({ record: await records.put(body.record as never) });
          case "delete":
            await records.delete(body.id as string);
            return json({ ok: true });
          case "list":
            return json(await records.list((body.query ?? {}) as never));
          case "claim": {
            const expected = body.expected as { id: string; data: unknown; refs?: Record<string, string> };
            const current = await records.get(expected.id);
            if (current === null || !sameValue(current, expected)) return json({ claimed: false });
            const replacement = body.replacement as { data: unknown; refs?: Record<string, string> } | undefined;
            if (replacement === undefined) {
              await records.delete(expected.id);
            } else {
              await records.put({
                id: expected.id,
                data: replacement.data as never,
                ...(replacement.refs === undefined ? {} : { refs: replacement.refs }),
              });
            }
            return json({ claimed: true });
          }
          case "atomic/insert-if-absent":
            return json({ record: await records.atomic!.insertIfAbsent(body.record as never) });
          case "atomic/compare-and-swap":
            return json({
              record: await records.atomic!.compareAndSwap(
                body.record as never,
                body.expectedRevision as string,
              ),
            });
          default:
            return miss(`unknown records method: ${method}`);
        }
      }

      if (rest[0] === "sessions" && request.method === "POST") {
        const body = recorded.json as Record<string, unknown>;
        const now = typeof body.now === "number" ? body.now : Date.now();
        const idleMs = typeof body.idleMs === "number" ? body.idleMs : 0;
        const cutoff = now - idleMs;
        switch (rest[1]) {
          case "register": {
            // Mirrors the console's clamp (vendo-web session-registry.ts):
            // touch never moves a subject's stamp BACKWARD.
            const subject = body.subject as string;
            sessions.set(subject, Math.max(sessions.get(subject) ?? now, now));
            return json({ ok: true });
          }
          case "adopt": {
            const from = body.from as string;
            if (!sessions.has(from)) return json({ report: null });
            sessions.delete(from);
            // Data movement is the engine's job (console-side tests prove it
            // with real per-org stores); the fake answers the report shape.
            return json({ report: { apps: 0, threads: 0, states: 0, skipped: 0 } });
          }
          case "stale":
            return json({
              subjects: [...sessions.entries()]
                .filter(([, touched]) => touched <= cutoff)
                .map(([subject]) => subject),
            });
          case "claim": {
            const subject = body.subject as string;
            const touched = sessions.get(subject);
            if (touched === undefined || touched > cutoff) return json({ claimed: false });
            sessions.delete(subject);
            return json({ claimed: true });
          }
          default:
            return miss(`unknown session method: ${rest[1]}`);
        }
      }

      if (rest[0] === "blobs") {
        const namespace = rest[1]!;
        const blobs = adapter.blobs(namespace);
        if (rest.length === 2 && request.method === "GET") {
          const keys = await blobs.list(url.searchParams.get("prefix") ?? "");
          return json({ keys });
        }
        const key = rest.slice(2).join("/");
        if (request.method === "PUT") {
          const contentType = recorded.contentType ?? undefined;
          await blobs.put(key, recorded.bytes ?? new Uint8Array(), contentType === undefined ? undefined : { contentType });
          return json({ ok: true });
        }
        if (request.method === "GET") {
          const blob = await blobs.get(key);
          if (blob === null) return envelope("not-found", "Blob not found.");
          return new Response(blob.bytes.slice().buffer as ArrayBuffer, {
            headers: blob.contentType === undefined ? {} : { "content-type": blob.contentType },
          });
        }
        if (request.method === "DELETE") {
          await blobs.delete(key);
          return json({ ok: true });
        }
      }

      if (rest[0] === "erase" && request.method === "POST") {
        eraseCalls.push(recorded.json);
        const body = recorded.json as { subject?: string };
        if (typeof body.subject === "string") sessions.delete(body.subject);
        return json({ report: { vendo_apps: 1, vendo_threads: 2 } });
      }

      return miss();
    } catch (error) {
      if (isUnserved(error)) throw error;
      if (error instanceof VendoError) return envelope(error.code, error.message);
      return envelope("unavailable", error instanceof Error ? error.message : String(error));
    }
  };

  return { adapter, requests, eraseCalls, sessions, handler };
}
