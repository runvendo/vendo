/** Typed error taxonomy (spec §9). */
export type ErrorCode = "sandbox" | "bridge" | "provision" | "version" | "timeout" | "abort";
export interface RpcError { code: ErrorCode; message: string }

export interface RpcRequest { vendo: true; id: string; method: string; params?: unknown }
export interface RpcResponse { vendo: true; id: string; result?: unknown; error?: RpcError }
export type RpcMessage = RpcRequest | RpcResponse;

/** A postMessage-shaped endpoint, so the bridge is testable without a real window. */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", handler: (e: { data: unknown }) => void): void;
}
