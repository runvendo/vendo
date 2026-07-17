/** SPIKE — shared latency record + tiny stats/reporting helpers. */

export interface TurnMetrics {
  rung: string;
  scenario: string;
  trial: number;
  /** ms from turn submission to first assistant text delta */
  ttftMs: number | null;
  /** ms from turn submission to turn completion */
  totalMs: number;
  model?: string;
  usage?: unknown;
  answer?: string;
  notes?: string;
}

export function now(): number {
  return performance.now();
}

export function summarize(rows: TurnMetrics[]): string {
  const byKey = new Map<string, TurnMetrics[]>();
  for (const r of rows) {
    const k = `${r.rung} · ${r.scenario}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const lines: string[] = [
    "| rung · scenario | trials | TTFT ms (min/med/max) | total ms (min/med/max) |",
    "|---|---|---|---|",
  ];
  for (const [k, rs] of byKey) {
    const ttfts = rs.map((r) => r.ttftMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const totals = rs.map((r) => r.totalMs).sort((a, b) => a - b);
    const fmt = (xs: number[]) =>
      xs.length === 0
        ? "—"
        : `${Math.round(xs[0]!)} / ${Math.round(xs[Math.floor(xs.length / 2)]!)} / ${Math.round(xs[xs.length - 1]!)}`;
    lines.push(`| ${k} | ${rs.length} | ${fmt(ttfts)} | ${fmt(totals)} |`);
  }
  return lines.join("\n");
}

export async function appendResults(file: string, rows: TurnMetrics[]): Promise<void> {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(file), { recursive: true });
  let existing: TurnMetrics[] = [];
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as TurnMetrics[];
  } catch {
    /* first write */
  }
  await writeFile(file, JSON.stringify([...existing, ...rows], null, 2));
}
