/**
 * Cadence's sandbox host bundle: the pre-wired catalog PLUS the app's own
 * registered components. Built by flowlet-sandbox/vite.config.mts (the
 * @flowlet/stage build preset) and copied to public/flowlet/ at predev.
 */
import { installFlowletHost } from "@flowlet/components/sandbox";
import { cadenceHostImpls } from "../src/flowlet/host-components/impls";

// The utility rules Cadence's registered components rely on (the app styles
// them with Tailwind classes, which don't exist inside the sandbox). Values
// mirror globals.css design tokens; the manual form of the component CSS the
// ENG-197 extractor will eventually emit.
const CADENCE_HOST_CSS = `
.inline-flex { display: inline-flex; }
.items-center { align-items: center; }
.gap-1\\.5 { gap: 6px; }
.rounded-full { border-radius: 9999px; }
.px-2 { padding-left: 8px; padding-right: 8px; }
.py-0\\.5 { padding-top: 2px; padding-bottom: 2px; }
.text-\\[11px\\] { font-size: 11px; line-height: 1.4; }
.font-medium { font-weight: 500; }
.whitespace-nowrap { white-space: nowrap; }
.h-1\\.5 { height: 6px; }
.w-1\\.5 { width: 6px; }
.h-full { height: 100%; }
.w-full { width: 100%; }
.overflow-hidden { overflow: hidden; }
.border { border-width: 1px; border-style: solid; }
.transition-\\[width\\] { transition-property: width; }
.duration-500 { transition-duration: 500ms; }
.bg-current { background-color: currentColor; }
/* Cadence status tints (globals.css @theme) */
.bg-status-missing-bg { background-color: #fdf0df; }
.text-status-missing { color: #b45309; }
.bg-status-overdue-bg { background-color: #fdeae8; }
.text-status-overdue { color: #b91c1c; }
.bg-status-review-bg { background-color: #e8eefc; }
.text-status-review { color: #1d4ed8; }
.bg-status-verified-bg { background-color: #e2f5ec; }
.text-status-verified { color: #047857; }
.bg-status-verified { background-color: #047857; }
.bg-evergreen-500 { background-color: #34816a; }
.border-line { border-color: #e9e4db; }
.bg-line\\/80 { background-color: rgba(233, 228, 219, 0.8); }
.bg-surface { background-color: #f7f5f1; }
.text-ink-soft { color: #5c554b; }
`;

installFlowletHost(cadenceHostImpls, { css: CADENCE_HOST_CSS });
