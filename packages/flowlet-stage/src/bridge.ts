import type { MessageEndpoint, RpcRequest, RpcResponse, RpcError } from "./protocol";

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
    if (!msg || (msg as Record<string, unknown>).flowlet !== true) return;
    if ("method" in msg && msg.method != null && onRequest) {
      const id = msg.id!;
      try {
        const result = await onRequest(msg.method, (msg as RpcRequest).params);
        post.postMessage({ flowlet: true, id, result } satisfies RpcResponse);
      } catch (err) {
        const error: RpcError = { code: "bridge", message: err instanceof Error ? err.message : String(err) };
        post.postMessage({ flowlet: true, id, error } satisfies RpcResponse);
      }
    } else if ("id" in msg && msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      p.cleanup();
      const resp = msg as RpcResponse;
      resp.error
        ? p.reject(Object.assign(new Error(resp.error.message), { code: resp.error.code }))
        : p.resolve(resp.result);
    }
  };
  listen.addEventListener("message", handler);

  return {
    call(method, params, opts) {
      const id = `rpc-${seq++}`;
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
        post.postMessage({ flowlet: true, id, method, params } satisfies RpcRequest);
      });
    },
    dispose() {
      listen.removeEventListener("message", handler);
      pending.forEach((p) => p.cleanup());
      pending.clear();
    },
  };
}
