/**
 * Sandbox host bundle for @vendoai/components alone (the pre-wired catalog
 * with no host components). Loaded inside the Vendo stage via blob import();
 * React resolves through the stage's import map (shared shim).
 *
 * Host apps that register their OWN components build their own entry with the
 * same one-liner — see installVendoHost.
 */
import { installVendoHost } from "../src/sandbox-install";

installVendoHost();
