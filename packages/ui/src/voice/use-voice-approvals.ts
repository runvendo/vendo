import type { ApprovalRequest } from "@vendoai/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { humanizeToolName } from "../chrome/humanize.js";
import type { VendoClient } from "../client.js";

const POLL_MS = 1_200;
const RECEIPT_MS = 2_600;

export interface VoiceApprovalReceipt {
  approved: boolean;
  title: string;
}

export function useVoiceApprovals(client: VendoClient, active: boolean) {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<VoiceApprovalReceipt>();
  const decidedRef = useRef(new Set<string>());
  const receiptTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      decidedRef.current.clear();
      setPending([]);
      setBusyId(undefined);
      setError(undefined);
      setReceipt(undefined);
      if (receiptTimerRef.current) clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = undefined;
      return;
    }

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const requests = await client.approvals.pending();
        if (alive) setPending(requests.filter((request) => !decidedRef.current.has(request.id)));
      } catch {
        // Voice remains usable if approval polling is temporarily unavailable.
      } finally {
        if (alive) timer = setTimeout(() => void poll(), POLL_MS);
      }
    };

    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [active, client]);

  useEffect(() => () => {
    if (receiptTimerRef.current) clearTimeout(receiptTimerRef.current);
  }, []);

  const decide = useCallback(async (request: ApprovalRequest, approve: boolean) => {
    setBusyId(request.id);
    setError(undefined);
    try {
      await client.approvals.decide(request.id, { approve });
      decidedRef.current.add(request.id);
      setPending((current) => current.filter((item) => item.id !== request.id));
      setReceipt({ approved: approve, title: approvalTitle(request) });
      if (receiptTimerRef.current) clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = setTimeout(() => setReceipt(undefined), RECEIPT_MS);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Couldn't record that decision");
    } finally {
      setBusyId(undefined);
    }
  }, [client]);

  return { pending, request: pending[0], busyId, error, receipt, decide };
}

export function approvalTitle(request: ApprovalRequest): string {
  const description = request.descriptor.description.trim();
  const pretty = humanizeToolName(request.descriptor.name);
  return description || (pretty.trim() ? pretty : "Requested action");
}
