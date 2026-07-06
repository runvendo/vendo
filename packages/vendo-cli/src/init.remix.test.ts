import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInit } from "./init.js";
import type { Interactor, MultiSelectOptions, MultiSelectValue } from "./interact.js";
import { textModel } from "./test-helpers.js";

/**
 * A Next.js fixture whose only LLM-touchable surface is the remix scan: widgets
 * live OUTSIDE any `components/` dir (so the catalog picker finds nothing) and
 * there are no `app/api` routes (so the route scan makes no model call). The
 * ONLY model call a run makes is remix discovery.
 */
async function remixOnlyApp(widgets: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "init-remix-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "host", dependencies: { next: "15.0.0" } }));
  await mkdir(path.join(dir, "src/app"), { recursive: true });
  await writeFile(path.join(dir, "src/app/globals.css"), ":root { --color-bg: #ffffff; }");
  for (const [rel, content] of Object.entries(widgets)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return dir;
}

function remixProposal(proposals: Array<{ file: string; id: string; label: string; reason: string }>): string {
  return JSON.stringify({ proposals });
}

/** A picker seam whose `multiSelect` returns whatever `pick` computes from the
 *  offered options; records the labels shown and the invocation count. */
function pickerInteractor(
  pick: (opts: MultiSelectOptions<MultiSelectValue>) => MultiSelectValue[] | null,
): { interactor: Interactor; shown: () => string[]; calls: () => number } {
  let shown: string[] = [];
  let calls = 0;
  return {
    shown: () => shown,
    calls: () => calls,
    interactor: {
      async maskedInput() {
        return null;
      },
      async multiSelect(opts) {
        calls++;
        shown = opts.options.map((o) => o.label);
        return pick(opts as MultiSelectOptions<MultiSelectValue>) as never;
      },
    },
  };
}

async function runCaptured(
  opts: Parameters<typeof runInit>[0],
): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runInit(opts);
    return { code, out: log.mock.calls.flat().join("\n"), err: err.mock.calls.flat().join("\n") };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

describe("runInit remix picker", () => {
  it("interactive run wraps only the picked widget and leaves the unpicked one untouched", async () => {
    const dir = await remixOnlyApp({
      "src/dashboard/DeadlineList.tsx": "export function DeadlineList() { return <ul><li>x</li></ul>; }\n",
      "src/dashboard/InvoiceCard.tsx": "export function InvoiceCard() { return <div>card</div>; }\n",
    });
    const invoiceBefore = await readFile(path.join(dir, "src/dashboard/InvoiceCard.tsx"), "utf8");

    const { interactor, shown } = pickerInteractor(() => ["src/dashboard/DeadlineList.tsx"]);
    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      model: textModel([
        remixProposal([
          { file: "src/dashboard/DeadlineList.tsx", id: "deadline-list", label: "Deadline list", reason: "list of deadlines" },
          { file: "src/dashboard/InvoiceCard.tsx", id: "invoice-card", label: "Invoice card", reason: "an invoice summary" },
        ]),
      ]),
    });

    expect(code).toBe(0);
    // The picker offered both, labeled by component name.
    expect(shown()).toEqual(["DeadlineList", "InvoiceCard"]);

    // The picked widget got the anchor + the shell import.
    const deadline = await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8");
    expect(deadline).toContain('<VendoRemix id="deadline-list" label="Deadline list">');
    expect(deadline).toContain('import { VendoRemix } from "@vendoai/shell";');

    // The unpicked widget is byte-for-byte unchanged.
    expect(await readFile(path.join(dir, "src/dashboard/InvoiceCard.tsx"), "utf8")).toBe(invoiceBefore);

    // Summary points at sync capturing baselines next build.
    expect(out).toContain("remix anchors: 1 wrapped");
    expect(out).toContain("deadline-list <- src/dashboard/DeadlineList.tsx");
    expect(out).toContain("vendo sync");
  });

  it("--yes skips the whole step: prints the hint, never prompts, never edits source", async () => {
    const dir = await remixOnlyApp({
      "src/dashboard/DeadlineList.tsx": "export function DeadlineList() { return <ul><li>x</li></ul>; }\n",
    });
    const before = await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8");
    const { interactor, calls } = pickerInteractor(() => []);

    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      yes: true, // forces interactive off even with a model present
      interactor,
      model: textModel([remixProposal([{ file: "src/dashboard/DeadlineList.tsx", id: "d", label: "D", reason: "r" }])]),
    });

    expect(code).toBe(0);
    expect(calls()).toBe(0); // no picker ever opened
    expect(out).toContain("stay human-gated"); // the hint
    expect(out).toContain("`vendo refresh`");
    // Source is byte-for-byte unchanged — no discovery, no splice.
    expect(await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8")).toBe(before);
    expect(out).not.toContain("remix anchors:");
  });

  it("no-model run prints the hint and never opens the picker", async () => {
    const dir = await remixOnlyApp({
      "src/dashboard/DeadlineList.tsx": "export function DeadlineList() { return <ul><li>x</li></ul>; }\n",
    });
    const before = await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8");
    const { interactor, calls } = pickerInteractor(() => []);

    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      model: null, // no provider key resolved
    });

    expect(code).toBe(0);
    expect(calls()).toBe(0);
    // No-model skip → the hint blames the missing key, not interactivity.
    expect(out).toContain("add a provider API key");
    expect(out).not.toContain("run `vendo init` or `vendo refresh` in an interactive terminal");
    expect(await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8")).toBe(before);
  });

  it("zero remix candidates prints a quiet line and opens no picker", async () => {
    const dir = await remixOnlyApp({
      "src/dashboard/DeadlineList.tsx": "export function DeadlineList() { return <ul><li>x</li></ul>; }\n",
    });
    const { interactor, calls } = pickerInteractor(() => []);

    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      model: textModel([remixProposal([])]), // LLM proposes nothing
    });

    expect(code).toBe(0);
    expect(calls()).toBe(0);
    expect(out).toContain("remix anchors: no widget-shaped components found to wrap.");
  });

  it("a splice-ambiguous pick is reported skipped, the file is unchanged, and init still exits 0", async () => {
    const dir = await remixOnlyApp({
      // A fragment return has no single top-level element — anchor.ts skips it.
      "src/dashboard/Ambiguous.tsx": "export function Ambiguous() { return <>{1}{2}</>; }\n",
    });
    const before = await readFile(path.join(dir, "src/dashboard/Ambiguous.tsx"), "utf8");
    const { interactor } = pickerInteractor(() => ["src/dashboard/Ambiguous.tsx"]);

    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      model: textModel([remixProposal([{ file: "src/dashboard/Ambiguous.tsx", id: "ambiguous", label: "Ambiguous", reason: "r" }])]),
    });

    expect(code).toBe(0);
    expect(out).toContain("skipped Ambiguous (src/dashboard/Ambiguous.tsx)");
    expect(out).toMatch(/fragment/i);
    // The manual by-hand instructions are printed for the developer.
    expect(out).toContain('<VendoRemix id="ambiguous" label="Ambiguous">');
    // Nothing was wrapped, so no file was touched.
    expect(await readFile(path.join(dir, "src/dashboard/Ambiguous.tsx"), "utf8")).toBe(before);
  });

  it("disambiguates duplicate component names in the picker by appending the file path", async () => {
    const dir = await remixOnlyApp({
      "src/dashboard/a/Card.tsx": "export function Card() { return <div>a</div>; }\n",
      "src/dashboard/b/Card.tsx": "export function Card() { return <div>b</div>; }\n",
    });
    const { interactor, shown } = pickerInteractor(() => []); // pick nothing; we only inspect labels

    const { code } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      model: textModel([
        remixProposal([
          { file: "src/dashboard/a/Card.tsx", id: "card-a", label: "Card", reason: "r" },
          { file: "src/dashboard/b/Card.tsx", id: "card-b", label: "Card", reason: "r" },
        ]),
      ]),
    });

    expect(code).toBe(0);
    expect(shown()).toEqual(["Card (src/dashboard/a/Card.tsx)", "Card (src/dashboard/b/Card.tsx)"]);
  });

  it("cancelling the picker (Ctrl-C) skips the step, wrapping nothing", async () => {
    const dir = await remixOnlyApp({
      "src/dashboard/DeadlineList.tsx": "export function DeadlineList() { return <ul><li>x</li></ul>; }\n",
    });
    const before = await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8");
    const { interactor } = pickerInteractor(() => null); // cancel

    const { code, out } = await runCaptured({
      targetDir: dir,
      skipLlm: false,
      force: false,
      interactive: true,
      interactor,
      model: textModel([remixProposal([{ file: "src/dashboard/DeadlineList.tsx", id: "d", label: "D", reason: "r" }])]),
    });

    expect(code).toBe(0);
    expect(out).toContain("remix picker skipped — nothing wrapped.");
    expect(await readFile(path.join(dir, "src/dashboard/DeadlineList.tsx"), "utf8")).toBe(before);
  });
});
