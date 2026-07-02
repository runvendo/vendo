/**
 * Maple's sandbox host bundle: the pre-wired catalog PLUS the app's own
 * registered components. Built by flowlet-sandbox/vite.config.ts (the
 * @flowlet/stage build preset) and copied to public/flowlet/ at predev.
 *
 * This two-line entry is the whole bundle story for a host app.
 */
import { installFlowletHost } from "@flowlet/components/sandbox";
import { mapleHostImpls } from "../src/flowlet/host-components/impls";

installFlowletHost(mapleHostImpls);
