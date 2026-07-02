/**
 * Maple's host-API tools (ENG-202): the bank's own OpenAPI spec, adapted into
 * Flowlet host tool definitions. ONE derivation feeds BOTH sides —
 * the server registers these through the agent's caller seam (no execute;
 * policy + approval cards), and the browser executes approved calls on the
 * user's session via the provider's host-tool runner.
 *
 * Isomorphic on purpose: no Node or React imports.
 */
import { openApiToHostTools, type HostToolDefinition } from "@flowlet/core";
import spec from "../../openapi.json";

export const mapleHostToolDefs: HostToolDefinition[] = openApiToHostTools(spec);
