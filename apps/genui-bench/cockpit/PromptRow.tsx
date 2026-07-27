"use client";

import { useEffect, useState } from "react";
import type { LaneName, RunRequest } from "../runner/types";
import { ALL_LANES } from "./lane-meta";

export interface Pack {
  name: string;
  prompts: string[];
}

/** Prompt row: free-text prompt, packs dropdown (pick a pack prompt or save
 *  the current one into a pack), per-run lane toggle chips, Run. */
export function PromptRow({
  prompt,
  onPromptChange,
  enabledLanes,
  onToggleLane,
  running,
  onRun,
}: {
  prompt: string;
  onPromptChange: (prompt: string, packRef?: RunRequest["packRef"]) => void;
  enabledLanes: LaneName[];
  onToggleLane: (lane: LaneName) => void;
  running: boolean;
  onRun: () => void;
}) {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [open, setOpen] = useState(false);
  const [newPack, setNewPack] = useState("");

  useEffect(() => {
    void refreshPacks(setPacks);
  }, []);

  const canRun = !running && prompt.trim() !== "" && enabledLanes.length > 0;

  const saveTo = async (pack: string) => {
    const name = pack.trim();
    if (!name || !prompt.trim()) return;
    const res = await fetch("/api/packs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pack: name, prompt: prompt.trim() }),
    });
    if (res.ok) {
      setNewPack("");
      await refreshPacks(setPacks);
    }
  };

  return (
    <div className="promptrow">
      <div className="promptbox">
        <input
          value={prompt}
          placeholder="describe the app to generate…"
          aria-label="Prompt"
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canRun) onRun();
          }}
        />
      </div>
      <div className="packwrap">
        <button type="button" className="pack" onClick={() => setOpen((value) => !value)}>
          Packs ▾
        </button>
        {open && (
          <>
            <div className="menu-backdrop" onClick={() => setOpen(false)} />
            <div className="packmenu" role="menu">
              {packs.map((pack) => (
                <div key={pack.name}>
                  <h4>
                    {pack.name} ({pack.prompts.length})
                    <button type="button" onClick={() => void saveTo(pack.name)}>
                      + save current
                    </button>
                  </h4>
                  {pack.prompts.map((packPrompt, index) => (
                    <button
                      key={index}
                      type="button"
                      className="packprompt"
                      onClick={() => {
                        onPromptChange(packPrompt, { pack: pack.name, index });
                        setOpen(false);
                      }}
                    >
                      {packPrompt}
                    </button>
                  ))}
                </div>
              ))}
              <div className="packnew">
                <input
                  value={newPack}
                  placeholder="new pack name"
                  aria-label="New pack name"
                  onChange={(event) => setNewPack(event.target.value)}
                />
                <button type="button" onClick={() => void saveTo(newPack)}>
                  save current
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <div className="lanes-toggle">
        {ALL_LANES.map((lane) => (
          <button
            key={lane}
            type="button"
            className={`lane-chip${enabledLanes.includes(lane) ? " on" : ""}`}
            aria-pressed={enabledLanes.includes(lane)}
            onClick={() => onToggleLane(lane)}
          >
            {lane === "thesys-c1" ? "c1" : lane}
          </button>
        ))}
      </div>
      <button type="button" className="runbtn" disabled={!canRun} onClick={onRun}>
        {running ? "Running…" : "Run ↵"}
      </button>
    </div>
  );
}

async function refreshPacks(setPacks: (packs: Pack[]) => void): Promise<void> {
  try {
    const res = await fetch("/api/packs");
    if (res.ok) setPacks(((await res.json()) as { packs: Pack[] }).packs);
  } catch {
    // Packs are a convenience; the prompt box works without them.
  }
}
