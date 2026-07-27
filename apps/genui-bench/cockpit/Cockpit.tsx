"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostName, LaneName, RunRecord, RunRequest } from "../runner/types";
import type { PaneComponent } from "./pane-props";
import { ALL_LANES } from "./lane-meta";
import { makeClientFixture } from "./client-fixture";
import { TopBar } from "./TopBar";
import { PromptRow } from "./PromptRow";
import { HistoryRail } from "./HistoryRail";
import { PaneGrid } from "./PaneGrid";
import { InternalsDrawer } from "./InternalsDrawer";

const POLL_MS = 5000;

/** The cockpit: one RunRecord loaded at a time, runs fired through
 *  POST /api/run (the same executeRun the CLI uses), history polled from
 *  /api/runs so agent CLI runs appear in the rail automatically. */
export function Cockpit({ panes }: { panes: Record<LaneName, PaneComponent> }) {
  const [host, setHost] = useState<HostName>("maple");
  const [prompt, setPrompt] = useState("");
  const packRef = useRef<RunRequest["packRef"]>(undefined);
  const [enabledLanes, setEnabledLanes] = useState<LaneName[]>([...ALL_LANES]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [current, setCurrent] = useState<RunRecord | null>(null);
  const [compare, setCompare] = useState<RunRecord | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/runs");
      if (res.ok) setRuns(((await res.json()) as { runs: RunRecord[] }).runs);
    } catch {
      // Poll again next tick.
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
    const timer = setInterval(() => void refreshRuns(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshRuns]);

  /** Click = load read-only; ⌥-click = split-compare against the current
   *  run (clicking the compare run again clears it). */
  const selectRun = useCallback(
    async (id: string, altKey: boolean) => {
      if (altKey && compare?.id === id) {
        setCompare(null);
        return;
      }
      const res = await fetch(`/api/runs/${id}`);
      if (!res.ok) return;
      const record = (await res.json()) as RunRecord;
      if (altKey && current && current.id !== id) {
        setCompare(record);
      } else {
        setCurrent(record);
        setCompare(null);
        setHost(record.request.host);
      }
    },
    [compare, current],
  );

  /** Pin = label in run.json ("baseline" by default); toggle unpins. */
  const togglePin = useCallback(
    async (run: RunRecord) => {
      let pin: string | null = null;
      if (!run.pin) {
        const label = typeof window.prompt === "function" ? window.prompt("Pin label", "baseline") : "baseline";
        if (label === null) return; // cancelled
        pin = label.trim() === "" ? "baseline" : label.trim();
      }
      const res = await fetch("/api/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: run.id, pin }),
      });
      if (res.ok) void refreshRuns();
    },
    [refreshRuns],
  );

  const fireRun = useCallback(async () => {
    const request: RunRequest = {
      prompt: prompt.trim(),
      host,
      lanes: enabledLanes,
      ...(packRef.current ? { packRef: packRef.current } : {}),
    };
    setRunning(true);
    setError(null);
    setCompare(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok) throw new Error(await res.text());
      setCurrent((await res.json()) as RunRecord);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
      void refreshRuns();
    }
  }, [prompt, host, enabledLanes, refreshRuns]);

  const fixture = useMemo(() => makeClientFixture(host), [host]);
  const gridLanes = current?.request.lanes ?? enabledLanes;

  return (
    <div className="cockpit">
      <TopBar host={host} onHostChange={setHost} />
      <PromptRow
        prompt={prompt}
        onPromptChange={(value, fromPack) => {
          setPrompt(value);
          packRef.current = fromPack;
        }}
        enabledLanes={enabledLanes}
        onToggleLane={(lane) =>
          setEnabledLanes((lanes) =>
            lanes.includes(lane) ? lanes.filter((l) => l !== lane) : [...lanes, lane],
          )
        }
        running={running}
        onRun={() => void fireRun()}
      />
      {error && <div className="gp-error" role="alert">{error}</div>}
      <div className="main">
        <HistoryRail
          runs={runs}
          selectedId={current?.id ?? null}
          compareId={compare?.id ?? null}
          onSelect={(id, altKey) => void selectRun(id, altKey)}
          onTogglePin={(run) => void togglePin(run)}
        />
        <PaneGrid
          panes={panes}
          lanes={gridLanes}
          record={current}
          compare={compare}
          running={running}
          host={fixture}
        />
      </div>
      <InternalsDrawer record={current} compare={compare} />
    </div>
  );
}
