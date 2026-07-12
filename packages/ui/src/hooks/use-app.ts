/** Single-app transport (08-ui §3). */
import type { AppDocument, AppId, Json, ToolOutcome } from "@vendoai/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVendoContext } from "../context.js";
import type { EditResult, OpenSurface, VersionEntry } from "../wire-types.js";

export function useApp(appId: AppId): {
  app: AppDocument | undefined;
  surface: OpenSurface | undefined;
  call(ref: string, args: Json): Promise<ToolOutcome>;
  edit(instruction: string): Promise<EditResult>;
  history: { list(): Promise<VersionEntry[]>; undo(): Promise<AppDocument> };
  refresh(): Promise<void>;
} {
  const { client } = useVendoContext();
  const [app, setApp] = useState<AppDocument>();
  const [surface, setSurface] = useState<OpenSurface>();
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = generationRef.current;
    const [nextApp, nextSurface] = await Promise.all([client.apps.get(appId), client.apps.open(appId)]);
    if (generation !== generationRef.current) return;
    setApp(nextApp);
    setSurface(nextSurface);
  }, [appId, client]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setApp(undefined);
    setSurface(undefined);
    void refresh().catch(() => undefined);
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

  return { app, surface, call, edit, history, refresh };
}
