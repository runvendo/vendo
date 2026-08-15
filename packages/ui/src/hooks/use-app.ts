/** Single-app transport (08-ui §3). */
import {
  type AppDocument,
  type AppId,
  type Json,
  type ToolOutcome,
} from "@vendoai/core";
import { effectiveAppBuildUiDeadlineMs } from "@vendoai/apps/contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVendoProvider } from "../context.js";
import type { EditResult, OpenSurface, VersionEntry } from "../wire-types.js";

/** How many times a load may try before the error becomes the user's problem.
 *  A pinned app is mounted, unattended chrome — one dropped `apps.open` used to
 *  leave every surface on its skeleton until a full page reload. */
const LOAD_ATTEMPTS = 3;
/** Doubling from here: 300ms, 600ms. Short enough that a transient blip heals
 *  inside the skeleton the user is already looking at. */
const RETRY_BASE_MS = 300;
/** A screen that is not servable YET answers the build window's `{kind:"pending"}`
 *  (wire/apps.ts) rather than failing — a ✦ remix's row lands tens of seconds
 *  before the screen its first edit generates. Keep asking on the app embed's
 *  cadence (APP_POLL_MS, chrome/embeds.tsx) until it lands or the ONE shared
 *  build deadline turns the wait into an error the surface can act on. */
const PENDING_POLL_MS = 1200;

export interface AppOptions {
  /** H16 — `false` means DON'T boot: no `apps.get`, no `apps.open`, no iframe.
   *  A grid of live app tiles gates this on visibility so the thirty apps below
   *  the fold cost nothing until they are scrolled to. Defaults on, so every
   *  existing caller is unchanged. */
  enabled?: boolean;
}

export function useApp(appId: AppId, { enabled = true }: AppOptions = {}): {
  app: AppDocument | undefined;
  surface: OpenSurface | undefined;
  error: Error | undefined;
  isLoading: boolean;
  call(ref: string, args: Json): Promise<ToolOutcome>;
  edit(instruction: string): Promise<EditResult>;
  history: { list(): Promise<VersionEntry[]> };
  refresh(): Promise<void>;
} {
  const { client } = useVendoProvider();
  const [app, setApp] = useState<AppDocument>();
  const [surface, setSurface] = useState<OpenSurface>();
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const generationRef = useRef(0);
  // Reset per appId (below), so `isLoading` reflects only the first load of the
  // current app — an edit refresh does not flicker it true→false.
  const loadedRef = useRef(false);

  const refresh = useCallback(async () => {
    // Mirror useResource: bump per call, so overlapping refreshes (manual +
    // edit) can never let a stale response clobber newer app state.
    const generation = (generationRef.current += 1);
    const current = () => generation === generationRef.current;
    if (!loadedRef.current) setIsLoading(true);
    setError(undefined);
    const deadline = Date.now() + effectiveAppBuildUiDeadlineMs();
    for (let attempt = 1; current();) {
      try {
        const [nextApp, nextSurface] = await Promise.all([
          client.apps.get(appId),
          client.apps.open(appId, { pending: true }),
        ]);
        if (!current()) return;
        if (nextSurface.kind === "pending") {
          if (Date.now() >= deadline) {
            setError(new Error(`app ${appId} was still being generated when the build window ran out`));
            setIsLoading(false);
            return;
          }
          // A pending answer is the wire working, not a failure: it must not
          // spend one of the retries above, or the wait ends in 900ms again.
          await new Promise(resolve => setTimeout(resolve, PENDING_POLL_MS));
          continue;
        }
        setApp(nextApp);
        setSurface(nextSurface);
        loadedRef.current = true;
        setIsLoading(false);
        return;
      } catch (reason) {
        if (!current()) return;
        if (attempt >= LOAD_ATTEMPTS) {
          setError(reason instanceof Error ? reason : new Error(String(reason)));
          setIsLoading(false);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, RETRY_BASE_MS * 2 ** (attempt - 1)));
        attempt += 1;
      }
    }
  }, [appId, client]);

  useEffect(() => {
    loadedRef.current = false;
    setApp(undefined);
    setSurface(undefined);
    setError(undefined);
    // Nothing is loading while the surface is off, so say so rather than
    // leaving a consumer on a skeleton that will never resolve.
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    void refresh();
    // Bump the generation on unmount / appId change so an in-flight response
    // can't land on a stale (or torn-down) app.
    return () => {
      generationRef.current += 1;
    };
  }, [enabled, refresh]);

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
    () => ({ list: () => client.apps.history(appId) }),
    [appId, client],
  );

  return { app, surface, error, isLoading, call, edit, history, refresh };
}
