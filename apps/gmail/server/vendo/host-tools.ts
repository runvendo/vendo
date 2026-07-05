/**
 * The clone's host-API tools (ENG-202): openapi.json adapted into Vendo host
 * tool definitions. ONE derivation feeds BOTH sides — the server registers
 * these through the caller seam (no execute; policy + approval cards), and the
 * browser executes approved calls on the user's session.
 *
 * Isomorphic on purpose: no Node or React imports.
 */
import { openApiToHostTools, type HostToolDefinition } from "@vendoai/core";
import spec from "../../src/openapi.json";

export const gmailHostToolDefs: HostToolDefinition[] = openApiToHostTools(spec);
