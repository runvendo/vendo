import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneName, LaneResult, RunRecord } from "./types";

/** Artifact filenames per lane, alongside run.json in `runs/<id>/`. */
const wireFile = (lane: LaneName) => `${lane}.wire.txt`;
const documentFile = (lane: LaneName) => `${lane}.document.json`;
const findingsFile = (lane: LaneName) => `${lane}.findings.json`;
const rawFile = (lane: LaneName) => `${lane}.raw.json`;

/**
 * Persist a RunRecord: `run.json` keeps the slim record (statuses, timings,
 * pin); the bulky per-lane payloads (wire/document/findings/raw) go to sibling
 * artifact files so history listing stays cheap and artifacts stay greppable.
 * Returns the run.json path.
 */
export function saveRun(runsDir: string, record: RunRecord): string {
  const runDir = join(runsDir, record.id);
  mkdirSync(runDir, { recursive: true });

  const slimLanes: RunRecord["lanes"] = {};
  for (const [name, result] of Object.entries(record.lanes) as [LaneName, LaneResult][]) {
    if (result.status === "no-key") {
      slimLanes[name] = result;
      continue;
    }
    const { wire, raw, ...rest } = result;
    const { document, findings, ...slim } = rest as typeof rest & {
      document?: unknown;
      findings?: unknown;
    };
    slimLanes[name] = slim as LaneResult;

    if (wire !== undefined) writeFileSync(join(runDir, wireFile(name)), wire);
    if (document !== undefined) writeJson(join(runDir, documentFile(name)), document);
    if (findings !== undefined) writeJson(join(runDir, findingsFile(name)), findings);
    if (raw !== undefined) writeJson(join(runDir, rawFile(name)), raw);
  }

  const runJsonPath = join(runDir, "run.json");
  writeJson(runJsonPath, { ...record, lanes: slimLanes });
  return runJsonPath;
}

/** Slim records (no bulky artifacts), newest-first by createdAt. */
export function listRuns(runsDir: string): RunRecord[] {
  if (!existsSync(runsDir)) return [];
  const records: RunRecord[] = [];
  for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runJsonPath = join(runsDir, entry.name, "run.json");
    if (!existsSync(runJsonPath)) continue;
    records.push(JSON.parse(readFileSync(runJsonPath, "utf8")) as RunRecord);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Full record for one run: run.json plus rehydrated per-lane artifacts. */
export function loadRun(runsDir: string, id: string): RunRecord {
  const runDir = join(runsDir, id);
  const record = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as RunRecord;

  for (const [name, result] of Object.entries(record.lanes) as [LaneName, LaneResult][]) {
    if (result.status === "no-key") continue;
    const wirePath = join(runDir, wireFile(name));
    if (existsSync(wirePath)) result.wire = readFileSync(wirePath, "utf8");
    const documentPath = join(runDir, documentFile(name));
    if (existsSync(documentPath) && result.status === "ok") {
      result.document = JSON.parse(readFileSync(documentPath, "utf8"));
    }
    const findingsPath = join(runDir, findingsFile(name));
    if (existsSync(findingsPath) && result.status === "ok") {
      result.findings = JSON.parse(readFileSync(findingsPath, "utf8"));
    }
    const rawPath = join(runDir, rawFile(name));
    if (existsSync(rawPath)) result.raw = JSON.parse(readFileSync(rawPath, "utf8"));
  }
  return record;
}

/** Pin = a label in run.json; `undefined` unpins. Returns the updated slim record. */
export function setPin(runsDir: string, id: string, pin: string | undefined): RunRecord {
  const runJsonPath = join(runsDir, id, "run.json");
  const record = JSON.parse(readFileSync(runJsonPath, "utf8")) as RunRecord;
  if (pin === undefined) delete record.pin;
  else record.pin = pin;
  writeJson(runJsonPath, record);
  return record;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
