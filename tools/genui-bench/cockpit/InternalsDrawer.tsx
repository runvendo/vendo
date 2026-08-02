"use client";

import { useState } from "react";
import type { PipelineEvent } from "@vendoai/apps";
import type { LaneName, LaneResult, RunRecord } from "../runner/types";
import { formatDuration } from "./lane-meta";

type TabKey = "internals" | "wire" | "document" | `raw:${LaneName}`;

const COMPETITOR_TAB_LABELS: Partial<Record<LaneName, string>> = {
  "thesys-c1": "C1 raw",
  copilotkit: "CopilotKit raw",
  tambo: "Tambo raw",
};

/** Internals drawer: the Vendo lane's PipelineEvent timeline humanized
 *  (tag colored by outcome), plus tabs for the raw wire text, the final
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
  return <Timeline events={vendo.events ?? []} error={vendo.status === "failed" ? vendo.error : undefined} />;
}

function Timeline({ events, error }: { events: PipelineEvent[]; error?: string }) {
  if (events.length === 0 && !error) {
    return <div className="drawer-empty">(no pipeline events captured)</div>;
  }
  return (
    <div>
      {events.map((event, index) => {
        const { tag, tone, message } = humanize(event);
        return (
          <div key={index}>
            <div className="ev">
              <span className="t">{"ms" in event && typeof event.ms === "number" ? formatDuration(event.ms) : "·"}</span>
              <span className={`tag ${tone}`}>{tag}</span>
              <span className="msg">{message}</span>
            </div>
            {issuesOf(event).map((issue, i) => (
              <div className="ev-issue" key={i}>{issue}</div>
            ))}
          </div>
        );
      })}
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

/** The validation issues a stage carries when it ended without a valid
 *  document. Read structurally so stages that gain the field later (and older
 *  records that never had it) both work. */
function issuesOf(event: PipelineEvent): string[] {
  const { issues } = event as { issues?: unknown };
  return Array.isArray(issues) ? issues.filter((issue): issue is string => typeof issue === "string") : [];
}

type Tone = "ok" | "warn" | "err" | "info";

/** One humanized line per PipelineEvent stage; unknown stages (future engine
 *  instrumentation) fall back to their raw payload so nothing is hidden. */
function humanize(event: PipelineEvent): { tag: string; tone: Tone; message: string } {
  switch (event.stage) {
    case "full": {
      const count = issuesOf(event).length;
      return {
        tag: "full",
        tone: event.valid ? "ok" : "warn",
        message: `full-lane attempt ${event.attempt} · ${event.valid ? "valid" : "invalid"}${
          count === 0 ? "" : ` · ${count} issue${count === 1 ? "" : "s"}`
        }`,
      };
    }
    case "region-parallel":
      return event.fallback
        ? { tag: "regions", tone: "warn", message: `fell back to single lane: ${event.fallback}` }
        : {
            tag: "regions",
            tone: "info",
            message: `${event.sectionsLanded ?? "?"}/${event.sectionsPlanned ?? "?"} sections landed (parallel writers)`,
          };
    case "repair":
      return {
        tag: "repair",
        tone: event.repaired ? "ok" : "err",
        message: `${event.rounds} round${event.rounds === 1 ? "" : "s"} · ${
          event.repaired ? "repaired" : "not repaired"
        }${event.noValidFix > 0 ? ` · ${event.noValidFix} no-valid-fix` : ""}`,
      };
    case "island-repair":
      return {
        tag: "island-repair",
        tone: event.repaired ? "ok" : "err",
        message: `${event.islands} island${event.islands === 1 ? "" : "s"} rewritten · ${
          event.repaired ? "repaired" : "not repaired"
        }`,
      };
    case "end-pass":
      return { tag: "end-pass", tone: "info", message: event.applied ? "applied" : "skipped" };
    case "data-verify":
      return {
        tag: "data-verify",
        tone: event.applied ? "ok" : "info",
        message: `${event.relabels} relabel${event.relabels === 1 ? "" : "s"} · ${event.rebinds} rebind${
          event.rebinds === 1 ? "" : "s"
        }`,
      };
    default: {
      // Future stages (guardrail verdicts, smoke render, …) still show up.
      const { stage, ...payload } = event as { stage: string } & Record<string, unknown>;
      delete payload.issues; // rendered as its own rows below, not inline JSON
      return { tag: stage, tone: "info", message: JSON.stringify(payload) };
    }
  }
}
