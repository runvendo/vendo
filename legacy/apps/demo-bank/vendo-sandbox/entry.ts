/**
 * Maple's sandbox host bundle: the pre-wired catalog PLUS the app's own
 * registered components. Built by vendo-sandbox/vite.config.mts (the
 * @vendoai/stage build preset) and copied to public/vendo/ at predev.
 */
import { installVendoHost } from "@vendoai/components/sandbox";
import { mapleHostImpls } from "../src/vendo/host-components/impls";

// The utility rules Maple's registered components rely on (the app styles
// them with Tailwind classes, which don't exist inside the sandbox). This is
// the manual form of the component CSS the ENG-197 extractor will emit.
const MAPLE_HOST_CSS = `
.relative { position: relative; }
.absolute { position: absolute; }
.inset-0 { inset: 0; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.items-center { align-items: center; }
.justify-center { justify-content: center; }
.pointer-events-none { pointer-events: none; }
.text-\\[11px\\] { font-size: 11px; }
.uppercase { text-transform: uppercase; }
.tracking-\\[0\\.08em\\] { letter-spacing: 0.08em; }
.text-muted { color: var(--vendo-fg-muted, #8A8B92); }
.text-lg { font-size: 18px; line-height: 1.35; }
.font-semibold { font-weight: 600; }
.text-ink { color: var(--vendo-fg, #14151A); }
.tabular-nums { font-variant-numeric: tabular-nums; }
.block { display: block; }
.w-full { width: 100%; }
`;

installVendoHost(mapleHostImpls, { css: MAPLE_HOST_CSS });
