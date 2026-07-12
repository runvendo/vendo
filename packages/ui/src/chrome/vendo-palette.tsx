import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApps } from "../hooks/use-apps.js";
import { ChromeRoot } from "./chrome-root.js";

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
        <div
          ref={dialog}
          className="vendo-palette"
          role="dialog"
          aria-modal="true"
          aria-label="Vendo command palette"
          onKeyDown={onKeyDown}
          onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
        >
          <div className="vendo-dialog">
            <label>
              <span className="vendo-muted">Command</span>
              <input
                ref={input}
                className="vendo-input"
                role="combobox"
                aria-expanded="true"
                aria-controls="vendo-command-list"
                aria-autocomplete="list"
                aria-activedescendant={visible[active] ? `vendo-command-${visible[active]!.id}` : undefined}
                value={query}
                onChange={event => { setQuery(event.currentTarget.value); setActive(0); }}
              />
            </label>
            <ul id="vendo-command-list" className="vendo-palette-list" role="listbox">
              {visible.map((command, index) => (
                <li
                  id={`vendo-command-${command.id}`}
                  className="vendo-option"
                  role="option"
                  aria-selected={index === active}
                  key={command.id}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => select(command)}
                >{command.label}</li>
              ))}
              {visible.length === 0 ? <li className="vendo-muted">No matching commands</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </ChromeRoot>
  );
}
