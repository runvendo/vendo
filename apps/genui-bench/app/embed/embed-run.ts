import type { AppDocument } from "@vendoai/core";
import { loadRun } from "../../runner/store";
import { isSafeName, runsDir } from "../api/paths";

/** The Vendo lane's document for one run id, read straight off disk (the embed
 *  page is a server component, so it needs no API hop). `null` = unknown or
 *  malformed id, or a lane that produced no document. */
export function embedDocument(runId: string | undefined): AppDocument | null {
  if (runId === undefined || runId === "" || !isSafeName(runId)) return null;
  try {
    const lane = loadRun(runsDir, runId).lanes.vendo;
    return lane?.status === "ok" ? (lane.document ?? null) : null;
  } catch {
    return null;
  }
}

/** Every embed page takes the same query string: which run, and whether the
 *  view is the read-only half of a split-compare. */
export interface EmbedSearchParams {
  run?: string;
  mode?: string;
}
