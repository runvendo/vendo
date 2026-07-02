/**
 * Sandbox host bundle for @flowlet/components alone (the pre-wired catalog
 * with no host components). Loaded inside the Flowlet stage via blob import();
 * React resolves through the stage's import map (shared shim).
 *
 * Host apps that register their OWN components build their own entry with the
 * same one-liner — see installFlowletHost.
 */
import { installFlowletHost } from "../src/sandbox-install";

installFlowletHost();
