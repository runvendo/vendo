"use client";

import { useState } from "react";
import type { Finding } from "@vendoai/apps";
import type { LaneName, LaneResult, RunRecord } from "../runner/types";

type TabKey = "internals" | "wire" | "document" | `raw:${LaneName}`;

const COMPETITOR_TAB_LABELS: Partial<Record<LaneName, string>> = {
  "thesys-c1": "C1 raw",
  copilotkit: "CopilotKit raw",
  tambo: "Tambo raw",
};

/** Internals drawer: what the checking layer still found on the Vendo lane's
 *  app (tag colored by severity), plus tabs for the raw wire text, the final
 *  AppDocument JSON, and each competitor's raw payload. In split-compare the
 *  drawer stacks both runs' content. */
export function InternalsDrawer({
  record,
  compare,
}: {
  record: RunRecord | null;
  compare?: RunRecord | null;
}) {
  const [tab, setTab] = useState<TabKey>("internals");

  const rawTabs = record
    ? (Object.keys(COMPETITOR_TAB_LABELS) as LaneName[]).filter((lane) => {
        const result = record.lanes[lane];
        return result && result.status !== "no-key" && result.raw !== undefined;
      })
    : [];

  // A run without a given competitor lane would strand its raw tab — derive
  // the shown tab instead of resetting state after the fact.
  const active: TabKey =
    tab.startsWith("raw:") && !rawTabs.includes(tab.slice(4) as LaneName) ? "internals" : tab;

  const tabs: Array<[TabKey, string]> = [
    ["internals", "Vendo internals"],
    ["wire", "Wire"],
    ["document", "Document"],
    ...rawTabs.map((lane): [TabKey, string] => [`raw:${lane}`, COMPETITOR_TAB_LABELS[lane]!]),
  ];

  return (
    <div className="drawer">
      <div className="drawer-tabs">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`dtab${active === key ? " on" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {!record ? (
          <div className="drawer-empty">run something to see the pipeline internals</div>
        ) : compare ? (
          <>
            <div className="timeline-h">current · {record.id}</div>
            <TabContent record={record} tab={active} />
            <div className="timeline-h cmp">compare · {compare.id}</div>
            <TabContent record={compare} tab={active} />
          </>
        ) : (
          <TabContent record={record} tab={active} />
        )}
      </div>
    </div>
  );
}

function TabContent({ record, tab }: { record: RunRecord; tab: TabKey }) {
  if (tab.startsWith("raw:")) {
    const result = record.lanes[tab.slice(4) as LaneName];
    const raw = result && result.status !== "no-key" ? result.raw : undefined;
    return <pre>{raw === undefined ? "(no raw payload)" : JSON.stringify(raw, null, 2)}</pre>;
  }
  const vendo: LaneResult | undefined = record.lanes.vendo;
  if (!vendo || vendo.status === "no-key") {
    return <div className="drawer-empty">no vendo lane in this run</div>;
  }
  if (tab === "wire") return <pre>{vendo.wire ?? "(no wire text)"}</pre>;
  if (tab === "document") {
    return (
      <pre>
        {vendo.status === "ok" && vendo.document !== undefined
          ? JSON.stringify(vendo.document, null, 2)
          : "(no document)"}
      </pre>
    );
  }
  return (
    <Findings
      findings={vendo.status === "ok" ? (vendo.findings ?? []) : []}
      error={vendo.status === "failed" ? vendo.error : undefined}
    />
  );
}

function Findings({ findings, error }: { findings: Finding[]; error?: string }) {
  if (findings.length === 0 && !error) {
    return <div className="drawer-empty">(nothing found on this app)</div>;
  }
  return (
    <div>
      {findings.map((finding, index) => (
        <div className="ev" key={index}>
          <span className="t">·</span>
          <span className={`tag ${finding.severity === "block" ? "err" : "warn"}`}>{finding.severity}</span>
          <span className="msg">{finding.where} — {finding.message}</span>
        </div>
      ))}
      {error && (
        <div className="ev">
          <span className="t">·</span>
          <span className="tag err">failed</span>
          <span className="msg">{error}</span>
        </div>
      )}
    </div>
  );
}
