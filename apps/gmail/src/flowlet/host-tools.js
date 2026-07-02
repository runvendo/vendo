/**
 * Client half of the ENG-202 host-tool derivation: the SAME openapi.json the
 * server registers becomes the browser-side executors — approved calls run
 * HERE, on the user's own session against the app's real endpoints.
 */
import { openApiToHostTools } from "@flowlet/core";
import spec from "../openapi.json";

export const gmailHostToolDefs = openApiToHostTools(spec);
