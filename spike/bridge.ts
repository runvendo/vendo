// MCP-Apps-shaped: JSON-RPC-style { id, method, params } / { id, result|error }.
export interface RpcRequest { flowlet: true; id: string; method: string; params?: unknown }
export interface RpcResponse { flowlet: true; id: string; result?: unknown; error?: { code: string; message: string } }

export function makeRpc(target: Window, onRequest?: (method: string, params: unknown) => Promise<unknown>) {
  const pending = new Map<string, (r: RpcResponse) => void>();
  let seq = 0;

  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg?.flowlet) return;
    if ("method" in msg && onRequest) {
      try { target.postMessage({ flowlet: true, id: msg.id, result: await onRequest(msg.method, msg.params) }, "*"); }
      catch (err) { target.postMessage({ flowlet: true, id: msg.id, error: { code: "handler", message: String(err) } }, "*"); }
    } else if ("id" in msg && pending.has(msg.id)) {
      pending.get(msg.id)!(msg as RpcResponse); pending.delete(msg.id);
    }
  });

  return {
    call(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
      const id = `rpc-${seq++}`;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
        pending.set(id, (r) => { clearTimeout(t); r.error ? reject(new Error(r.error.message)) : resolve(r.result); });
        target.postMessage({ flowlet: true, id, method, params } satisfies RpcRequest, "*");
      });
    },
  };
}
