import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApps } from "../hooks/use-apps.js";
import { ChromeRoot } from "./chrome-root.js";

export interface VendoCommand {
  id: string;
  label: string;
  kind: "new-conversation" | "open-app" | "show-activity";
  appId?: string;
}

/** 08-ui §4 — global keyboard command palette with an ARIA combobox. */
export function VendoPalette({ onCommand }: { onCommand?(command: VendoCommand): void }) {
  const { apps } = useApps();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const commands = useMemo<VendoCommand[]>(() => [
    { id: "new-conversation", label: "New conversation", kind: "new-conversation" },
    ...apps.map(app => ({ id: `open-${app.id}`, label: `Open ${app.name}`, kind: "open-app" as const, appId: app.id })),
    { id: "show-activity", label: "Show activity", kind: "show-activity" },
  ], [apps]);
  const visible = useMemo(() => commands.filter(command => command.label.toLowerCase().includes(query.toLowerCase())), [commands, query]);

  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(value => !value);
      }
    };
    globalThis.addEventListener("keydown", listener);
    return () => globalThis.removeEventListener("keydown", listener);
  }, []);

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
    setOpen(false);
    onCommand?.(command);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
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
        <div className="vendo-palette" role="dialog" aria-modal="true" aria-label="Vendo command palette" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
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
                onKeyDown={onKeyDown}
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
