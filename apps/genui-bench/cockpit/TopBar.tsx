"use client";

import { useCallback, useEffect, useState } from "react";
import type { HostName } from "../runner/types";

export interface GitStateInfo {
  sha: string;
  dirtyFiles: string[];
  /** Most recently modified dirty file, when the tree is dirty. */
  lastTouched?: { file: string; modifiedAgoMs: number };
}

const HOSTS: Array<{ name: HostName; label: string }> = [
  { name: "maple", label: "Maple (bank)" },
  { name: "cadence", label: "Cadence (accounting)" },
];

/** Top bar: host picker + the git state of the code the NEXT run will use
 *  (sha, dirty marker, last-touched file) — refreshed on window focus. */
export function TopBar({
  host,
  onHostChange,
}: {
  host: HostName;
  onHostChange: (host: HostName) => void;
}) {
  const [git, setGit] = useState<GitStateInfo | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/git-state");
      if (res.ok) setGit((await res.json()) as GitStateInfo);
    } catch {
      // Dev server hiccup — keep the last known state.
    }
  }, []);

  useEffect(() => {
    const onFocus = () => void refresh();
    onFocus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const dirty = (git?.dirtyFiles.length ?? 0) > 0;
  return (
    <div className="topbar">
      <div className="logo">
        genui<span>-bench</span>
      </div>
      <div className="host-pick" role="radiogroup" aria-label="Host">
        {HOSTS.map(({ name, label }) => (
          <button
            key={name}
            type="button"
            className={host === name ? "on" : undefined}
            aria-pressed={host === name}
            onClick={() => onHostChange(name)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="gitstate">
        {git ? (
          <>
            <span className={`dot${dirty ? " dirty" : ""}`} />
            {git.sha.slice(0, 8)}
            {dirty && <b>+ dirty</b>}
            {dirty && git.lastTouched && (
              <span>
                · {git.lastTouched.file} modified {formatAgo(git.lastTouched.modifiedAgoMs)}
              </span>
            )}
          </>
        ) : (
          <span>…</span>
        )}
      </div>
    </div>
  );
}

function formatAgo(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
