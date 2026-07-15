import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApps } from "../hooks/use-apps.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { ChromeRoot } from "./chrome-root.js";
import { TakeoverPortal } from "./takeover-portal.js";

export interface VendoCommand {
  id: string;
  label: string;
  kind: "new-conversation" | "open-app" | "show-activity";
  appId?: string;
}

const FOCUSABLE = "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";

/** 08-ui §4 — global keyboard command palette with an ARIA combobox. */
export function VendoPalette({ onCommand }: { onCommand?(command: VendoCommand): void }) {
  const { apps } = useApps();
  const takeover = useMobileTakeover();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const commands = useMemo<VendoCommand[]>(() => [
    { id: "new-conversation", label: "New conversation", kind: "new-conversation" },
    ...apps.map(app => ({ id: `open-${app.id}`, label: `Open ${app.name}`, kind: "open-app" as const, appId: app.id })),
    { id: "show-activity", label: "Show activity", kind: "show-activity" },
  ], [apps]);
  const visible = useMemo(() => commands.filter(command => command.label.toLowerCase().includes(query.toLowerCase())), [commands, query]);

  const restoreFocus = useCallback(() => {
    queueMicrotask(() => opener.current?.focus());
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    restoreFocus();
  }, [restoreFocus]);

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(value => {
          if (value) {
            restoreFocus();
            return false;
          }
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          return true;
        });
      }
    };
    globalThis.addEventListener("keydown", listener);
    return () => globalThis.removeEventListener("keydown", listener);
  }, [restoreFocus]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      queueMicrotask(() => input.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(index => Math.min(index, Math.max(visible.length - 1, 0))), [visible.length]);

  const select = (command: VendoCommand | undefined) => {
    if (!command) return;
    close();
    onCommand?.(command);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(index => visible.length ? (index + 1) % visible.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(index => visible.length ? (index - 1 + visible.length) % visible.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      select(visible[active]);
    }
  };

  return (
    <ChromeRoot>
      {open ? (
        // ENG-228: in takeover the fixed scrim portals to body — a transformed
        // host ancestor would otherwise capture it and confine the palette.
        <TakeoverPortal active={takeover.active}>
        <div
          ref={dialog}
          className={`fl-overlay-scrim${takeover.active ? " fl-takeover" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-label="Vendo command palette"
          onKeyDown={onKeyDown}
          onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
          // ENG-228: in takeover the palette pins to the top edge (inside the
          // safe area) at full width, with the bottom padding tracking the
          // virtual keyboard so the visible list is never hidden behind it.
          style={takeover.active
            ? {
              display: "grid",
              alignContent: "start",
              padding: "calc(10px + env(safe-area-inset-top, 0px)) calc(10px + env(safe-area-inset-right, 0px)) calc(10px + env(safe-area-inset-bottom, 0px) + var(--fl-kb-inset, 0px)) calc(10px + env(safe-area-inset-left, 0px))",
              ...takeover.style,
            }
            : { display: "grid", padding: 18, placeItems: "center" }}
        >
          <div className="fl-picker" style={takeover.active ? { maxWidth: "none", width: "100%" } : { alignSelf: "center", maxWidth: 560 }}>
            <label>
              <span className="fl-picker-group" style={{ display: "block", margin: "0 2px 9px" }}>Command</span>
              <input
                ref={input}
                className="fl-picker-search"
                role="combobox"
                aria-expanded="true"
                aria-controls="vendo-command-list"
                aria-autocomplete="list"
                aria-activedescendant={visible[active] ? `vendo-command-${visible[active]!.id}` : undefined}
                value={query}
                onChange={event => { setQuery(event.currentTarget.value); setActive(0); }}
              />
            </label>
            <ul
              id="vendo-command-list"
              className="fl-picker-grid"
              role="listbox"
              style={{ gridTemplateColumns: "1fr", listStyle: "none", marginTop: 8 }}
            >
              {visible.map((command, index) => (
                <li
                  id={`vendo-command-${command.id}`}
                  className="fl-picker-item fl-option"
                  role="option"
                  aria-selected={index === active}
                  key={command.id}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => select(command)}
                  style={index === active
                    ? { background: "var(--vendo-accent-soft)", borderColor: "var(--vendo-border-strong)", cursor: "pointer" }
                    : { cursor: "pointer" }}
                >
                  <span className="fl-picker-ic" aria-hidden="true">
                    {command.kind === "new-conversation" ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    ) : command.kind === "open-app" ? (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect width="7" height="7" x="3" y="3" rx="1" />
                        <rect width="7" height="7" x="14" y="3" rx="1" />
                        <rect width="7" height="7" x="3" y="14" rx="1" />
                        <rect width="7" height="7" x="14" y="14" rx="1" />
                      </svg>
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 3v18h18" />
                        <path d="m7 16 4-5 4 3 4-7" />
                      </svg>
                    )}
                  </span>
                  <span className="fl-picker-nm">{command.label}</span>
                </li>
              ))}
              {visible.length === 0 ? <li className="fl-auto-sub">No matching commands</li> : null}
            </ul>
          </div>
        </div>
        </TakeoverPortal>
      ) : null}
    </ChromeRoot>
  );
}
