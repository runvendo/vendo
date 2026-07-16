/** Single-app transport (08-ui §3). */
import type { AppDocument, AppId, Json, ToolOutcome } from "@vendoai/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import type { EditResult, OpenSurface, VersionEntry } from "../wire-types.js";

export function useApp(appId: AppId): {
  app: AppDocument | undefined;
  /** Alias for `app` — the consistent `data` field across data hooks (§3). */
  data: AppDocument | undefined;
  surface: OpenSurface | undefined;
  error: Error | undefined;
  isLoading: boolean;
  call(ref: string, args: Json): Promise<ToolOutcome>;
  edit(instruction: string): Promise<EditResult>;
  history: { list(): Promise<VersionEntry[]>; undo(): Promise<AppDocument> };
  refresh(): Promise<void>;
} {
  const { client } = useVendoContext();
  const [app, setApp] = useState<AppDocument>();
  const [surface, setSurface] = useState<OpenSurface>();
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const generationRef = useRef(0);
  // Reset per appId (below), so `isLoading` reflects only the first load of the
  // current app — an edit/undo refresh does not flicker it true→false.
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    if (!loadedRef.current) setIsLoading(true);
    try {
      const [nextApp, nextSurface] = await Promise.all([client.apps.get(appId), client.apps.open(appId)]);
      if (generation !== generationRef.current) return;
      setApp(nextApp);
      setSurface(nextSurface);
      setError(undefined);
      loadedRef.current = true;
    } catch (reason) {
      if (generation !== generationRef.current) return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    } finally {
      if (generation === generationRef.current) setIsLoading(false);
    }
  }, [appId, client]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadedRef.current = false;
    setApp(undefined);
    setSurface(undefined);
    setError(undefined);
    void refresh();
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [refresh]);

  const call = useCallback((ref: string, args: Json) => client.apps.call(appId, ref, args), [appId, client]);
  const edit = useCallback(
    async (instruction: string) => {
      const result = await client.apps.edit(appId, instruction);
      await refresh();
      return result;
    },
    [appId, client, refresh],
  );
  const history = useMemo(
    () => ({
      list: () => client.apps.history(appId),
      undo: async () => {
        const result = await client.apps.undo(appId);
        await refresh();
        return result;
      },
    }),
    [appId, client, refresh],
  );

  return { app, data: app, surface, error, isLoading, call, edit, history, refresh };
}
