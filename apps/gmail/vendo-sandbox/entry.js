/**
 * The clone's sandbox host bundle (ENG-184 3-file path, step 3): the pre-wired
 * catalog PLUS the app's registered components, installed onto the stage
 * runtime's window contract. Built by vendo-sandbox/vite.config.mts and
 * copied to public/vendo/ at predev.
 */
import { installVendoHost } from "@vendoai/components/sandbox";
import { gmailHostImpls } from "./impls";

// The clone styles with styled-components (bundled CSS-in-JS), so unlike a
// Tailwind host there are no utility rules to ship — just the row font.
const GMAIL_HOST_CSS = `
[data-vendo-gmail-root] { font-family: Roboto, 'Segoe UI', Arial, sans-serif; }
`;

installVendoHost(gmailHostImpls, { css: GMAIL_HOST_CSS });
