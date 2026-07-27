"use client";

import { useEffect, useState } from "react";
import {
  EFFORT_LEVELS,
  MODELS,
  PRODUCTION_MODEL,
  describeModel,
  findModel,
  type RunModel,
} from "../runner/models";
import type { LaneName, RunRequest } from "../runner/types";
import { ALL_LANES } from "./lane-meta";

export interface Pack {
  name: string;
  prompts: string[];
}

/** Prompt row: free-text prompt, packs dropdown (pick a pack prompt or save
 *  the current one into a pack), the model control, per-run lane toggle
 *  chips, Run. */
export function PromptRow({
  prompt,
  onPromptChange,
  enabledLanes,
  onToggleLane,
  model,
  onModelChange,
  running,
  onRun,
}: {
  prompt: string;
  onPromptChange: (prompt: string, packRef?: RunRequest["packRef"]) => void;
  enabledLanes: LaneName[];
  onToggleLane: (lane: LaneName) => void;
  /** null = the engine default (no override sent). */
  model: RunModel | null;
  onModelChange: (model: RunModel | null) => void;
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
      <ModelControl model={model} onChange={onModelChange} />
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

/**
 * Compact model control: collapsed to one chip showing the model + sampling
 * the next run will use, expanding to the model list and the settings that
 * model actually accepts. Temperature and thinking are per-model dialects
 * (runner/models.ts), so the panel shows exactly one of them and says why
 * when the other is missing — a greyed-out knob is better than a run that
 * 400s at the provider.
 */
function ModelControl({
  model,
  onChange,
}: {
  model: RunModel | null;
  onChange: (model: RunModel | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const spec = model ? findModel(model.id) : undefined;

  return (
    <div className="packwrap">
      <button
        type="button"
        className="pack"
        aria-label="Model"
        onClick={() => setOpen((value) => !value)}
      >
        {model ? describeModel(model) : `Default · ${PRODUCTION_MODEL.label}`} ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="packmenu" role="menu">
            <h4>Model</h4>
            <button
              type="button"
              className="packprompt"
              aria-pressed={model === null}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {model === null ? "● " : "○ "}
              Default — {PRODUCTION_MODEL.label} (what ships)
            </button>
            {MODELS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="packprompt"
                aria-pressed={model?.id === entry.id}
                onClick={() => onChange({ id: entry.id })}
              >
                {model?.id === entry.id ? "● " : "○ "}
                {entry.label}
              </button>
            ))}

            {model && spec && (
              <>
                <h4>Sampling</h4>
                <div className="packnew">
                  {spec.temperature ? (
                    <>
                      <span>temperature</span>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        aria-label="Temperature"
                        value={model.temperature ?? ""}
                        placeholder="0"
                        onChange={(event) => {
                          const raw = event.target.value;
                          const rest = without(model, "temperature");
                          onChange(raw === "" ? rest : { ...rest, temperature: Number(raw) });
                        }}
                      />
                    </>
                  ) : (
                    <span>{spec.label} takes no temperature — use thinking effort</span>
                  )}
                </div>
                <div className="packnew">
                  {spec.thinking === "budget" ? (
                    <>
                      <span>thinking</span>
                      <input
                        type="number"
                        min={1024}
                        step={1024}
                        aria-label="Thinking budget"
                        value={model.thinkingBudget ?? ""}
                        placeholder="off"
                        onChange={(event) => {
                          const raw = event.target.value;
                          const rest = without(model, "thinkingBudget");
                          onChange(raw === "" ? rest : { ...rest, thinkingBudget: Number(raw) });
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <span>thinking</span>
                      {EFFORT_LEVELS.map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`lane-chip${model.effort === level ? " on" : ""}`}
                          aria-pressed={model.effort === level}
                          onClick={() => {
                            const rest = without(model, "effort");
                            onChange(model.effort === level ? rest : { ...rest, effort: level });
                          }}
                        >
                          {level}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Clear one setting (an empty field means "not set", not "set to zero"). */
function without(model: RunModel, key: "temperature" | "thinkingBudget" | "effort"): RunModel {
  const next = { ...model };
  delete next[key];
  return next;
}

async function refreshPacks(setPacks: (packs: Pack[]) => void): Promise<void> {
  try {
    const res = await fetch("/api/packs");
    if (res.ok) setPacks(((await res.json()) as { packs: Pack[] }).packs);
  } catch {
    // Packs are a convenience; the prompt box works without them.
  }
}
