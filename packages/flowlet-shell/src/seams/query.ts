import type { DataQuery } from "@flowlet/core";

/**
 * Host-provided execution seam for reopening saved views: run one declared
 * data query through the host's normal (policy-governed) tool path and return
 * the tool result. Same shape as a stage ActionRequest on purpose — in
 * embedded demo-bank this is one fetch to /api/flowlet/action.
 */
export type RunQuery = (query: DataQuery) => Promise<unknown>;
