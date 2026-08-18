/**
 * `useToolQuery` — the guarded read, in code-land (blueprint §5.4).
 *
 * There is no per-query HTTP endpoint and this does not add one: a read goes
 * through the door that already exists, `POST /apps/:appId/call`, which lands
 * on the guard-bound `AppCaller`. No second door, no second query path.
 *
 * The semantics: a non-ok outcome contributes NO data and sets
 * `dataUnavailable`, an "ok" answer that happens to be empty is an ANSWER, and
 * each distinct miss is reported once. §6.4: a failed load must never read as
 * "you have no spending".
 *
 * Total. A network failure is an unavailable read, not an exception.
 */

import { canonicalJson, type Json, type ToolOutcome } from "@vendoai/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVendoApp } from "./app-context.js";

export interface ToolQuery<T extends Json = Json> {
  /** The tool's output, or `undefined` — which means "not arrived", never
   *  "empty". Empty is `[]` / `{}` / `0`, and it arrives as itself. */
  data: T | undefined;
  /** A read is in flight (the first one, or a refetch). */
  loading: boolean;
  /** The read settled without data: refused, errored, or unreachable. Distinct
   *  from an empty answer, so a screen can say "we could not load this"
   *  instead of "you have nothing". */
  dataUnavailable: boolean;
  /** The non-ok outcome behind `dataUnavailable`, so a refusal that has an
   *  affordance (`connect-required`, `pending-approval`) can render one.
   *  `undefined` whenever the last read succeeded. */
  outcome: ToolOutcome | undefined;
  /** Read again. Never throws. */
  refetch(): Promise<void>;
}

interface Settled<T extends Json> {
  data: T | undefined;
  loading: boolean;
  dataUnavailable: boolean;
  outcome: ToolOutcome | undefined;
}

const LOADING = { data: undefined, loading: true, dataUnavailable: false, outcome: undefined } as const;

export function useToolQuery<T extends Json = Json>(ref: string, args?: Json): ToolQuery<T> {
  const { call, reportQueryMiss, registerQuery } = useVendoApp();
  const [settled, setSettled] = useState<Settled<T>>(LOADING);
  // The read that owns the screen. A superseded read's answer is dropped, so a
  // slow first response can never overwrite a newer one.
  const ticket = useRef(0);

  // ONE identity for (tool, args): an inline `{ month }` object is a new
  // reference on every render, and keying on it would read forever.
  const key = canonicalJson({ ref, args: args ?? {} });

  const read = useCallback(async () => {
    const mine = ticket.current + 1;
    ticket.current = mine;
    setSettled((current) => ({ ...current, loading: true }));
    const { ref: tool, args: input } = JSON.parse(key) as { ref: string; args: Json };
    const outcome = await call(tool, input);
    if (ticket.current !== mine) return;
    if (outcome.status === "ok") {
      setSettled({ data: outcome.output as T, loading: false, dataUnavailable: false, outcome: undefined });
      return;
    }
    reportQueryMiss(
      key,
      `[vendo] query "${tool}" resolved no data — the call answered "${outcome.status}"; `
      + "anything bound to it renders empty",
    );
    setSettled({ data: undefined, loading: false, dataUnavailable: true, outcome });
  }, [call, key, reportQueryMiss]);

  useEffect(() => {
    void read();
  }, [read]);

  // Mounted queries are what a successful action refreshes (§6.3 law 2).
  useEffect(() => registerQuery(read), [registerQuery, read]);

  return { ...settled, refetch: read };
}
