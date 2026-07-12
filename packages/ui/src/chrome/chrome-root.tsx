import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useVendoTheme } from "../context.js";
import { themeCssVariables } from "../theme.js";

const CHROME_CSS = `
.vendo-root,.vendo-root *{box-sizing:border-box}
.vendo-root{color:var(--vendo-color-text);background:var(--vendo-color-background);font-family:var(--vendo-font-family);font-size:var(--vendo-font-size);line-height:1.5}
.vendo-root button,.vendo-root input,.vendo-root textarea,.vendo-root select{font:inherit;color:inherit}
.vendo-root button,.vendo-root input,.vendo-root textarea,.vendo-root select,.vendo-root summary{min-height:calc(var(--vendo-font-size) * 2.75)}
.vendo-root button{border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-small);background:var(--vendo-color-surface);padding:calc(var(--vendo-font-size) * .45) calc(var(--vendo-font-size) * .75);cursor:pointer}
.vendo-root button:hover:not(:disabled){border-color:var(--vendo-color-accent)}
.vendo-root button:disabled{color:var(--vendo-color-muted);cursor:not-allowed}
.vendo-root :focus-visible{outline:calc(var(--vendo-font-size) * .16) solid var(--vendo-color-accent);outline-offset:calc(var(--vendo-font-size) * .14)}
.vendo-primary{background:var(--vendo-color-accent)!important;color:var(--vendo-color-accent-text)!important;border-color:var(--vendo-color-accent)!important}
.vendo-danger{color:var(--vendo-color-danger)!important;border-color:var(--vendo-color-danger)!important}
.vendo-muted{color:var(--vendo-color-muted)}
.vendo-stack{display:grid;gap:calc(var(--vendo-font-size) * .75)}
.vendo-row{display:flex;align-items:center;gap:calc(var(--vendo-font-size) * .55);flex-wrap:wrap}
.vendo-card{border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-medium);background:var(--vendo-color-surface);padding:var(--vendo-font-size)}
.vendo-chip{display:inline-flex;align-items:center;border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-large);padding:calc(var(--vendo-font-size) * .1) calc(var(--vendo-font-size) * .45);font-size:.85em;color:var(--vendo-color-muted)}
.vendo-chip[data-risk=write]{color:var(--vendo-color-accent);border-color:var(--vendo-color-accent)}
.vendo-chip[data-risk=destructive]{color:var(--vendo-color-danger);border-color:var(--vendo-color-danger)}
.vendo-input{width:100%;border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-small);background:var(--vendo-color-background);padding:calc(var(--vendo-font-size) * .55)}
.vendo-notice{border:calc(var(--vendo-font-size) * .16) solid var(--vendo-color-danger);border-inline-start-width:calc(var(--vendo-font-size) * .5);border-radius:var(--vendo-radius-medium);background:var(--vendo-color-surface);padding:var(--vendo-font-size);color:var(--vendo-color-danger)}
.vendo-notice code{color:var(--vendo-color-text)}
.vendo-approval-preview{margin:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-small);background:var(--vendo-color-background);padding:calc(var(--vendo-font-size) * .75);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--vendo-color-text)}
.vendo-approval fieldset{border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-small);margin:calc(var(--vendo-font-size) * .5) 0;padding:calc(var(--vendo-font-size) * .6)}
.vendo-thread{min-height:calc(var(--vendo-font-size) * 24);display:grid;grid-template-rows:auto 1fr auto;gap:var(--vendo-font-size)}
.vendo-messages{max-height:calc(var(--vendo-font-size) * 30);overflow:auto;display:grid;align-content:start;gap:calc(var(--vendo-font-size) * .75)}
.vendo-message{border-inline-start:calc(var(--vendo-font-size) * .2) solid var(--vendo-color-border);padding-inline-start:calc(var(--vendo-font-size) * .75)}
.vendo-message[data-role=user]{border-inline-start-color:var(--vendo-color-accent)}
.vendo-tool-receipt{display:flex;align-items:center;gap:calc(var(--vendo-font-size) * .45);color:var(--vendo-color-muted);font-size:.9em}
.vendo-composer textarea{resize:vertical;min-height:calc(var(--vendo-font-size) * 4)}
.vendo-launcher{position:fixed;inset-inline-end:var(--vendo-font-size);inset-block-end:var(--vendo-font-size);z-index:20;border-radius:var(--vendo-radius-large)!important;background:var(--vendo-color-accent)!important;color:var(--vendo-color-accent-text)!important}
.vendo-overlay{position:fixed;inset:0;z-index:19;display:grid;place-items:end;background:color-mix(in srgb,var(--vendo-color-background) 72%,transparent);padding:calc(var(--vendo-font-size) * 4) var(--vendo-font-size)}
.vendo-dialog{width:min(calc(var(--vendo-font-size) * 40),100%);max-height:calc(100dvh - var(--vendo-font-size) * 6);overflow:auto;border:1px solid var(--vendo-color-border);border-radius:var(--vendo-radius-large);background:var(--vendo-color-background);padding:var(--vendo-font-size);box-shadow:0 calc(var(--vendo-font-size) * .5) calc(var(--vendo-font-size) * 2) color-mix(in srgb,var(--vendo-color-text) 18%,transparent)}
.vendo-tabs{display:flex;gap:calc(var(--vendo-font-size) * .25);overflow:auto;border-block-end:1px solid var(--vendo-color-border)}
.vendo-tab[aria-selected=true]{color:var(--vendo-color-accent);border-color:var(--vendo-color-accent)}
.vendo-tabpanel{padding-block:var(--vendo-font-size)}
.vendo-page-grid{display:grid;grid-template-columns:minmax(calc(var(--vendo-font-size) * 11),.3fr) minmax(0,1fr);gap:var(--vendo-font-size)}
.vendo-app-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(calc(var(--vendo-font-size) * 14),1fr));gap:var(--vendo-font-size)}
.vendo-palette{position:fixed;inset:0;z-index:30;display:grid;place-items:start center;background:color-mix(in srgb,var(--vendo-color-background) 72%,transparent);padding-block-start:calc(var(--vendo-font-size) * 6)}
.vendo-palette-list{list-style:none;padding:0;margin:calc(var(--vendo-font-size) * .5) 0 0;max-height:calc(var(--vendo-font-size) * 18);overflow:auto}
.vendo-option{padding:calc(var(--vendo-font-size) * .6);border-radius:var(--vendo-radius-small)}
.vendo-option[aria-selected=true]{background:var(--vendo-color-accent);color:var(--vendo-color-accent-text)}
.vendo-table-wrap{overflow:auto}
.vendo-table{width:100%;border-collapse:collapse;text-align:start}
.vendo-table th,.vendo-table td{padding:calc(var(--vendo-font-size) * .55);border-block-end:1px solid var(--vendo-color-border);vertical-align:top;text-align:start}
.vendo-run-plan{border-inline-start:calc(var(--vendo-font-size) * .2) solid var(--vendo-color-accent);padding-inline-start:calc(var(--vendo-font-size) * .75)}
.vendo-root[data-vendo-motion=reduced] *{transition:none!important;animation:none!important;scroll-behavior:auto!important}
@media(prefers-reduced-motion:reduce){.vendo-root *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media(max-width:42rem){.vendo-page-grid{grid-template-columns:1fr}.vendo-dialog{width:100%}.vendo-overlay{padding-inline:0;padding-block-end:0}.vendo-overlay .vendo-dialog{border-end-start-radius:0;border-end-end-radius:0}}
`;

function ensureChromeStyles(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-vendo-chrome]")) return;
  const style = document.createElement("style");
  style.dataset.vendoChrome = "";
  style.textContent = CHROME_CSS;
  document.head.append(style);
}

/** 08-ui §4 — shared theme and stylesheet boundary for shipped chrome. */
export function ChromeRoot({ children, className }: { children: ReactNode; className?: string }) {
  const theme = useVendoTheme();
  useEffect(ensureChromeStyles, []);
  return (
    <div
      className={["vendo-root", className].filter(Boolean).join(" ")}
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)", fontSize: "var(--vendo-font-size)" } as CSSProperties}
    >
      {children}
    </div>
  );
}
