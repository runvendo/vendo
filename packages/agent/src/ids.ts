import type { ThreadId } from "@vendoai/core";

/** 03-agent §5 */
export function mintThreadId(): ThreadId {
  return `thr_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

/** 01-core §7 */
export function mintAuditId(): string {
  return `aud_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}
