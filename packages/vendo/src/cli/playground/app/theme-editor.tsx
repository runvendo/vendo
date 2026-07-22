/**
 * The playground's theme editor: a floating card top-right (Yousef's pick C)
 * that collapses to a "Theme" pill, and a grabber-handled bottom sheet at
 * phone widths. Every VendoTheme token is editable live; state lives in
 * main.tsx so the whole page (and the embed iframe) re-themes together.
 */
import type { VendoTheme } from "@vendoai/core";
import { useEffect, useState } from "react";
import {
  curatedFonts,
  fontStack,
  googleFontHref,
  primaryFontFamily,
  themeJson,
  themePresets,
} from "./theme-state.js";

const EDITOR_CSS = `
  /* Above the chrome's own overlay/takeover layers (they top out at
     2147483100) — the editor is harness tooling and must stay reachable
     while the overlay scenario is open. */
  .te-card, .te-pill { position: fixed; top: 16px; right: 16px; z-index: 2147483200; font-family: Onest, Inter, system-ui, sans-serif; }
  .te-card { width: 302px; max-height: calc(100vh - 32px); display: flex; flex-direction: column; background: #fafaf8; border: 1px solid rgba(23, 23, 26, 0.1); border-radius: 14px; box-shadow: 0 18px 44px rgba(23, 23, 26, 0.18); transform-origin: top right; transition: transform 320ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 320ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .te-card[data-closed="true"] { transform: scale(0.6) translateY(-8px); opacity: 0; pointer-events: none; }
  .te-pill { display: inline-flex; align-items: center; gap: 7px; background: #17171a; color: #fafaf8; border: none; border-radius: 999px; font: 600 12.5px Onest, Inter, sans-serif; padding: 9px 15px; cursor: pointer; box-shadow: 0 10px 26px rgba(23, 23, 26, 0.25); opacity: 0; pointer-events: none; transition: opacity 320ms cubic-bezier(0.2, 0.8, 0.2, 1); }
  .te-pill[data-shown="true"] { opacity: 1; pointer-events: auto; }
  .te-dot { width: 13px; height: 13px; border-radius: 50%; background: conic-gradient(#4338ca, #818cf8, #22d3ee, #4338ca); border: 1px solid rgba(255, 255, 255, 0.4); }
  .te-grab { display: none; }
  .te-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 10px; border-bottom: 1px solid rgba(23, 23, 26, 0.1); flex-shrink: 0; }
  .te-head b { font-size: 12.5px; color: #17171a; }
  .te-head small { display: block; font-weight: 500; font-size: 10.5px; color: #6f6f78; margin-top: 2px; }
  .te-x { border: none; background: none; color: #6f6f78; font-size: 14px; cursor: pointer; padding: 2px 6px; border-radius: 6px; line-height: 1; }
  .te-x:hover { background: rgba(67, 56, 202, 0.08); color: #17171a; }
  .te-body { overflow-y: auto; padding: 10px 14px 12px; font-size: 12.5px; color: #17171a; }
  .te-sec { margin-bottom: 14px; }
  .te-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #85858f; margin-bottom: 7px; }
  .te-presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .te-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid rgba(23, 23, 26, 0.1); background: #ffffff; border-radius: 999px; padding: 4px 10px 4px 5px; font: 600 11.5px Onest, Inter, sans-serif; cursor: pointer; color: #17171a; }
  .te-chip .te-swatch { width: 16px; height: 16px; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.12); }
  .te-chip[aria-pressed="true"] { border-color: #4338ca; box-shadow: inset 0 0 0 1px #4338ca; }
  .te-crow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .te-crow input[type="color"] { width: 24px; height: 24px; border: 1px solid rgba(23, 23, 26, 0.1); border-radius: 7px; padding: 1px; background: #ffffff; cursor: pointer; flex-shrink: 0; }
  .te-crow span { flex: 1; font-weight: 550; font-size: 11.5px; }
  .te-crow code { font: 500 10.5px ui-monospace, monospace; color: #6f6f78; }
  .te-body select, .te-body input[type="text"] { width: 100%; font: 500 12px Onest, Inter, sans-serif; color: #17171a; background: #ffffff; border: 1px solid rgba(23, 23, 26, 0.1); border-radius: 8px; padding: 6px 8px; }
  .te-body input[type="text"] { margin-top: 6px; }
  .te-srow { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .te-srow label { font-size: 11.5px; font-weight: 550; width: 62px; flex-shrink: 0; }
  .te-srow input[type="range"] { flex: 1; accent-color: #4338ca; min-width: 0; }
  .te-srow output { font: 500 10.5px ui-monospace, monospace; color: #6f6f78; width: 34px; text-align: right; flex-shrink: 0; }
  .te-segs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .te-seg { display: flex; background: #ffffff; border: 1px solid rgba(23, 23, 26, 0.1); border-radius: 9px; padding: 2px; gap: 2px; }
  .te-seg button { flex: 1; border: none; background: none; font: 600 11px Onest, Inter, sans-serif; color: #6f6f78; padding: 5px 0; border-radius: 7px; cursor: pointer; }
  .te-seg button[aria-pressed="true"] { background: #17171a; color: #fafaf8; }
  .te-foot { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid rgba(23, 23, 26, 0.1); flex-shrink: 0; }
  .te-foot button { flex: 1; font: 600 11.5px Onest, Inter, sans-serif; border-radius: 8px; padding: 7px 0; cursor: pointer; }
  .te-copy { background: #17171a; color: #fafaf8; border: 1px solid #17171a; }
  .te-link { background: #ffffff; color: #17171a; border: 1px solid rgba(23, 23, 26, 0.1); }
  @media (prefers-reduced-motion: reduce) {
    .te-card, .te-pill { transition: none; }
  }
  @media (max-width: 640px) {
    .te-card { top: auto; right: 0; left: 0; bottom: 0; width: auto; max-height: 72vh; border-radius: 18px 18px 0 0; border-left: none; border-right: none; border-bottom: none; padding-bottom: env(safe-area-inset-bottom, 0px); transform-origin: bottom center; box-shadow: 0 -16px 44px rgba(23, 23, 26, 0.3); }
    .te-card[data-closed="true"] { transform: translateY(105%); opacity: 1; }
    .te-pill { top: auto; bottom: calc(env(safe-area-inset-bottom, 0px) + 16px); }
    .te-grab { display: block; width: 40px; height: 4px; border-radius: 2px; background: rgba(23, 23, 26, 0.18); margin: 8px auto 0; flex-shrink: 0; }
    .te-x { padding: 6px 10px; }
  }
`;

const COLOR_KEYS = ["background", "surface", "text", "muted", "accent", "accentText", "danger", "border"] as const;

function samePreset(a: VendoTheme, b: VendoTheme): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** "12px" → 12 (slider value); tolerates rem-less numeric strings. */
function px(value: string): number {
  return Number.parseFloat(value) || 0;
}

/** Selection-based copy for contexts where the async clipboard is missing or
 * rejects (non-secure origins, unfocused automation documents). */
function copyViaSelection(value: string): boolean {
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function CopyButton({ className, label, copiedLabel, text }: { className: string; label: string; copiedLabel: string; text: () => string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    const value = text();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      if (copyViaSelection(value)) setCopied(true);
    }
  };
  return (
    <button type="button" className={className} onClick={() => void copy()}>
      {copied ? copiedLabel : label}
    </button>
  );
}

export function ThemeEditor({ theme, onChange }: { theme: VendoTheme; onChange(next: VendoTheme): void }) {
  const [open, setOpen] = useState(false);
  const [freeFont, setFreeFont] = useState("");

  const primary = primaryFontFamily(theme.typography.fontFamily);
  const selectValue = curatedFonts.find((font) => primaryFontFamily(fontStack(font)) === primary) ?? "custom";

  const set = (patch: Partial<VendoTheme>) => onChange({ ...theme, ...patch });
  const setColor = (key: (typeof COLOR_KEYS)[number], value: string) =>
    set({ colors: { ...theme.colors, [key]: value } });
  const setRadius = (key: keyof VendoTheme["radius"], value: number) =>
    set({ radius: { ...theme.radius, [key]: `${value}px` } });
  const applyFont = (family: string) => {
    if (!family.trim()) return;
    set({ typography: { ...theme.typography, fontFamily: fontStack(family) } });
  };

  return (
    <>
      <style>{EDITOR_CSS}</style>
      {/* inert (not just aria-hidden/pointer-events) so the hidden half is
          also removed from the Tab order (cubic P3 on PR #391). */}
      <button type="button" className="te-pill" data-shown={!open} inert={open} onClick={() => setOpen(true)} aria-label="Open theme editor">
        <span className="te-dot" />
        Theme
      </button>
      <div className="te-card" data-closed={!open} role="dialog" aria-label="Theme editor" inert={!open}>
        <div className="te-grab" />
        <div className="te-head">
          <div>
            <b>Theme editor</b>
            <small>edits every scenario live · VendoTheme</small>
          </div>
          <button type="button" className="te-x" onClick={() => setOpen(false)} aria-label="Close theme editor">
            ✕
          </button>
        </div>
        <div className="te-body">
          <div className="te-sec">
            <div className="te-label">Presets</div>
            <div className="te-presets">
              {themePresets.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className="te-chip"
                  aria-pressed={samePreset(theme, preset.theme)}
                  onClick={() => onChange(preset.theme)}
                >
                  <span className="te-swatch" style={{ background: preset.theme.colors.accent }} />
                  {preset.name}
                </button>
              ))}
            </div>
          </div>
          <div className="te-sec">
            <div className="te-label">Colors</div>
            {COLOR_KEYS.map((key) => (
              <div key={key} className="te-crow">
                <input
                  type="color"
                  value={theme.colors[key]}
                  onChange={(event) => setColor(key, event.target.value)}
                  aria-label={`${key} color`}
                />
                <span>{key}</span>
                <code>{theme.colors[key]}</code>
              </div>
            ))}
          </div>
          <div className="te-sec">
            <div className="te-label">Typography</div>
            <select
              value={selectValue}
              onChange={(event) => applyFont(event.target.value)}
              aria-label="Font family"
            >
              {curatedFonts.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
              {selectValue === "custom" && <option value="custom">{primary} (custom)</option>}
            </select>
            <input
              type="text"
              placeholder="or any Google Font — Enter to apply"
              value={freeFont}
              onChange={(event) => setFreeFont(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                applyFont(freeFont);
                setFreeFont("");
              }}
              aria-label="Custom Google Font"
            />
            <div className="te-srow">
              <label htmlFor="te-basesize">baseSize</label>
              <input
                id="te-basesize"
                type="range"
                min={12}
                max={18}
                value={px(theme.typography.baseSize)}
                onChange={(event) =>
                  set({ typography: { ...theme.typography, baseSize: `${event.target.value}px` } })
                }
              />
              <output>{theme.typography.baseSize}</output>
            </div>
          </div>
          <div className="te-sec">
            <div className="te-label">Radius</div>
            {(
              [
                ["small", 14],
                ["medium", 20],
                ["large", 28],
              ] as const
            ).map(([key, max]) => (
              <div key={key} className="te-srow">
                <label htmlFor={`te-radius-${key}`}>{key}</label>
                <input
                  id={`te-radius-${key}`}
                  type="range"
                  min={0}
                  max={max}
                  value={px(theme.radius[key])}
                  onChange={(event) => setRadius(key, Number(event.target.value))}
                />
                <output>{theme.radius[key]}</output>
              </div>
            ))}
          </div>
          <div className="te-sec">
            <div className="te-label">Density · Motion</div>
            <div className="te-segs">
              <div className="te-seg" role="group" aria-label="Density">
                {(["comfortable", "compact"] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={theme.density === value} onClick={() => set({ density: value })}>
                    {value}
                  </button>
                ))}
              </div>
              <div className="te-seg" role="group" aria-label="Motion">
                {(["full", "reduced"] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={theme.motion === value} onClick={() => set({ motion: value })}>
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="te-foot">
          <CopyButton className="te-copy" label="Copy theme.json" copiedLabel="Copied ✓" text={() => themeJson(theme)} />
          <CopyButton className="te-link" label="Copy link" copiedLabel="Link copied ✓" text={() => window.location.href} />
        </div>
      </div>
    </>
  );
}

/** Keep the page's on-demand Google Fonts <link> in sync with the theme. */
export function useGoogleFont(fontFamily: string): void {
  useEffect(() => {
    const href = googleFontHref(primaryFontFamily(fontFamily));
    const id = "vendo-playground-google-font";
    const existing = document.getElementById(id) as HTMLLinkElement | null;
    if (!href) {
      existing?.remove();
      return;
    }
    if (existing) {
      if (existing.href !== href) existing.href = href;
      return;
    }
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
  }, [fontFamily]);
}
