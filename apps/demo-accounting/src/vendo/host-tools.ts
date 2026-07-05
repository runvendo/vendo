/**
 * Cadence's host-API tools (ENG-202): the practice-management platform's own
 * OpenAPI spec, adapted into Vendo host tool definitions. ONE derivation
 * feeds BOTH sides — the server registers these through the agent's caller
 * seam (no execute; policy + approval cards), and the browser executes
 * approved calls on the signed-in firm user's session.
 *
 * The `/api/demo/*` operations (reset, simulate upload) are choreography for
 * the human driving the demo, not capabilities for the agent — they are
 * excluded here so the model never sees them.
 *
 * Isomorphic on purpose: no Node or React imports.
 */
import { openApiToHostTools, type HostToolDefinition } from "@vendoai/core";
import spec from "../../openapi.json";

export const cadenceHostToolDefs: HostToolDefinition[] = openApiToHostTools(spec).filter(
  (def) => !def.http.path.startsWith("/api/demo/"),
);
