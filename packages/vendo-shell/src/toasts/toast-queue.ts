/**
 * Toast queue policy (VendoToasts, 2026-07-04 spec), pure and timer-free so
 * every rule is unit-testable: max 2 visible with FIFO backfill, dedupe by
 * (kind, runId, stepId), suppression while a conversation is active (hides,
 * never drops), approvals persist until acted on. Auto-dismiss timing lives in
 * the component; "while you were away" collapsing lives in the poller.
 */

export type ToastKind = "completed" | "approval-required" | "digest";
export type ToastState = "fresh" | "approving" | "stale" | "error";

export interface ToastInput {
  kind: ToastKind;
  runId?: string;
  stepId?: string;
  summary: string;
  text: string;
}

export interface Toast extends ToastInput {
  key: string;
  state: ToastState;
  /** True while the toast must not auto-dismiss (pending approvals). */
  persistent: boolean;
}

export function toastKey(input: ToastInput): string {
  return `${input.kind}:${input.runId ?? ""}:${input.stepId ?? ""}`;
}

export interface ToastQueue {
  push(input: ToastInput): void;
  dismiss(key: string): void;
  setState(key: string, state: ToastState): void;
  setSuppressed(suppressed: boolean): void;
  visible(): Toast[];
  subscribe(listener: () => void): () => void;
}

export const MAX_VISIBLE = 2;

export function createToastQueue(): ToastQueue {
  const queue: Toast[] = [];
  let suppressed = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  // visible() result is cached between mutations: useSyncExternalStore needs
  // a stable snapshot reference or it loops forever re-rendering.
  let snapshot: Toast[] = [];
  const rebuild = () => {
    snapshot = suppressed ? [] : queue.slice(0, MAX_VISIBLE);
    notify();
  };

  const isPersistent = (kind: ToastKind, state: ToastState) =>
    kind === "approval-required" && (state === "fresh" || state === "approving");

  return {
    push(input) {
      const key = toastKey(input);
      if (queue.some((t) => t.key === key)) return;
      queue.push({ ...input, key, state: "fresh", persistent: isPersistent(input.kind, "fresh") });
      rebuild();
    },
    dismiss(key) {
      const index = queue.findIndex((t) => t.key === key);
      if (index === -1) return;
      queue.splice(index, 1);
      rebuild();
    },
    setState(key, state) {
      const toast = queue.find((t) => t.key === key);
      if (!toast || toast.state === state) return;
      toast.state = state;
      toast.persistent = isPersistent(toast.kind, state);
      rebuild();
    },
    setSuppressed(next) {
      if (suppressed === next) return;
      suppressed = next;
      rebuild();
    },
    visible: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
