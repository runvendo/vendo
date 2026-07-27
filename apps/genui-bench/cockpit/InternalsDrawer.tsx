"use client";

import { useState } from "react";
import type { RunRecord } from "../runner/types";

/** Internals drawer shell (Task 6): tab chrome + raw dumps of the Vendo
 *  lane's events/wire/document. The humanized timeline, per-competitor raw
 *  tabs, and compare stacking land in Task 7. */
export function InternalsDrawer({ record }: { record: RunRecord | null }) {
  const [tab, setTab] = useState<"internals" | "wire" | "document">("internals");
  const vendo = record?.lanes.vendo;
  const detail = vendo && vendo.status !== "no-key" ? vendo : undefined;

  return (
    <div className="drawer">
      <div className="drawer-tabs">
        {(
          [
            ["internals", "Vendo internals"],
            ["wire", "Wire"],
            ["document", "Document"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`dtab${tab === key ? " on" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {!detail ? (
          <div className="drawer-empty">run something to see the pipeline internals</div>
        ) : tab === "internals" ? (
          <pre>{JSON.stringify(detail.events ?? [], null, 2)}</pre>
        ) : tab === "wire" ? (
          <pre>{detail.wire ?? "(no wire text)"}</pre>
        ) : (
          <pre>
            {detail.status === "ok" && detail.document !== undefined
              ? JSON.stringify(detail.document, null, 2)
              : "(no document)"}
          </pre>
        )}
      </div>
    </div>
  );
}
