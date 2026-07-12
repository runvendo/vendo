import type { MessageEndpoint, RpcRequest, RpcResponse, RpcError } from "./protocol.js";

export interface RpcHandle {
  call(method: string, params?: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  dispose(): void;
}

export function makeRpc(
  listen: MessageEndpoint,
  post: MessageEndpoint,
  onRequest?: (method: string, params: unknown) => Promise<unknown>,
  defaults?: { timeoutMs?: number },
): RpcHandle {
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; cleanup: () => void }>();
  let seq = 0;
  const defaultTimeout = defaults?.timeoutMs ?? 5000;

  const handler = async (e: { data: unknown }) => {
    const msg = e.data as Partial<RpcRequest & RpcResponse> | undefined;
    if (!msg || (msg as Record<string, unknown>).vendo !== true) return;

    // A RESPONSE is recognised by a response shape that matches a pending call —
    // not merely "no method". This wins over the request path so a message that
    // carries both `method` and a pending `id` resolves the call (no misrouting).
    const isResponse =
      typeof msg.id === "string" &&
      ("result" in msg || "error" in msg) &&
      pending.has(msg.id);
    // A REQUEST requires BOTH a method and an id (so we can reply). An id-less
    // notification is NOT a request and must not invoke onRequest.
    const isRequest = typeof msg.method === "string" && typeof msg.id === "string";

    if (isResponse) {
      const id = msg.id as string;
      const p = pending.get(id)!;
      pending.delete(id);
      p.cleanup();
      const resp = msg as RpcResponse;
      resp.error
        ? p.reject(Object.assign(new Error(resp.error.message), { code: resp.error.code }))
        : p.resolve(resp.result);
    } else if (isRequest && onRequest) {
      const id = msg.id as string;
      try {
        const result = await onRequest(msg.method as string, (msg as RpcRequest).params);
        post.postMessage({ vendo: true, id, result } satisfies RpcResponse);
      } catch (err) {
        const error: RpcError = { code: "bridge", message: err instanceof Error ? err.message : String(err) };
        post.postMessage({ vendo: true, id, error } satisfies RpcResponse);
      }
    }
  };
  listen.addEventListener("message", handler);

  const nonce = Math.random().toString(36).slice(2, 8);

  return {
    call(method, params, opts) {
      const id = `rpc-${nonce}-${seq++}`;
      const timeoutMs = opts?.timeoutMs ?? defaultTimeout;
      return new Promise<unknown>((resolve, reject) => {
        const signal = opts?.signal;
        const fail = (code: RpcError["code"], message: string) => {
          if (!pending.has(id)) return;
          pending.delete(id);
          cleanup();
          reject(Object.assign(new Error(message), { code }));
        };
        const t = setTimeout(() => fail("timeout", `timeout: ${method}`), timeoutMs);
        const onAbort = () => fail("abort", `aborted: ${method}`);
        const cleanup = () => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); };
        if (signal?.aborted) {
          clearTimeout(t);
          return reject(Object.assign(new Error(`aborted: ${method}`), { code: "abort" }));
        }
        signal?.addEventListener("abort", onAbort);
        pending.set(id, { resolve, reject, cleanup });
        post.postMessage({ vendo: true, id, method, params } satisfies RpcRequest);
      });
    },
    dispose() {
      listen.removeEventListener("message", handler);
      pending.forEach((p) => p.cleanup());
      pending.clear();
    },
  };
}
