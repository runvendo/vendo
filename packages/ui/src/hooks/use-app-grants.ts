/** App-access transport (build contract §9.2–§9.6): who this app is shared
    with, and what the caller themselves may do with it. */
import type { AccessLevel, AppGrantRecord, AppId, ResolvedPerson } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";

interface AppGrantsState {
  /** The caller's own effective level — null when they cannot see the app at
      all. This is what a surface reads to choose between "Edit" and the
      consumer-voice fork offer, so it never has to guess from an error. */
  level: AccessLevel | null;
  grants: AppGrantRecord[];
  /** Still the caller's own copy? "Share implies promote" (§9.5) reads this,
      so no surface has to be told — and none can forget to pass it. */
  personal: boolean;
}

const EMPTY: AppGrantsState = { level: null, grants: [], personal: false };

export function useAppGrants(appId: AppId | undefined, options?: PollOptions): AppGrantsState & {
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  /** Owner-only, Cloud-gated: a viewer's attempt comes back `forbidden`, a
      keyless deployment's comes back `cloud-required`, and both are honest
      sentences the dialog renders rather than a disabled button with no
      explanation. */
  share(principal: string, level: AccessLevel): Promise<void>;
  unshare(principal: string): Promise<void>;
  /** "Share implies promote": handing a personal app to an org moves it. */
  promote(orgId: string): Promise<void>;
  /** §9.1 companion — ask the HOST who a typed name is. `null` = it does not
      know them; the grant is then never written, and the app never moves. */
  resolvePerson(query: string): Promise<ResolvedPerson | null>;
} {
  const { client } = useVendoContext();
  const load = useCallback(
    async () => appId === undefined ? EMPTY : await client.apps.grants(appId),
    [client, appId],
  );
  const { data, error, isLoading, refresh } = useResource(load, EMPTY, options);

  const share = useCallback(async (principal: string, level: AccessLevel) => {
    if (appId === undefined) return;
    await client.apps.share(appId, principal, level);
    await refresh();
  }, [client, appId, refresh]);

  const unshare = useCallback(async (principal: string) => {
    if (appId === undefined) return;
    await client.apps.unshare(appId, principal);
    await refresh();
  }, [client, appId, refresh]);

  const promote = useCallback(async (orgId: string) => {
    if (appId === undefined) return;
    await client.apps.promote(appId, orgId);
    await refresh();
  }, [client, appId, refresh]);

  const resolvePerson = useCallback(async (query: string) => {
    if (appId === undefined) return null;
    return (await client.apps.resolvePerson(appId, query)).person;
  }, [client, appId]);

  return {
    ...data,
    error,
    isLoading,
    refresh,
    share,
    unshare,
    promote,
    resolvePerson,
  };
}
