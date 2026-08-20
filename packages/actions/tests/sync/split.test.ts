import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkComponentScreen, PORTED_SCREEN_DIALECT } from "@vendoai/apps";
import { afterEach, describe, expect, it } from "vitest";
import { seedBaselineSchema } from "../../src/formats.js";
import { capturePins } from "../../src/sync/seeds.js";

/** Assembled at runtime for the same reason pins.test.ts does it: the
 *  dependency guard's static text scan reads import-shaped strings even inside
 *  fixtures, and actions may not import @vendoai/ui. */
const UI_CHROME = ["@vendoai", "ui", "chrome"].join("/");

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vendo-split-"));
  temporaryDirectories.push(root);
  return root;
}

async function write(root: string, relativePath: string, source: string): Promise<void> {
  const file = path.join(root, relativePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source, "utf8");
}

async function baselineFor(root: string, slot: string) {
  return seedBaselineSchema.parse(JSON.parse(
    await fs.readFile(path.join(root, ".vendo/remixable", `${slot}.json`), "utf8"),
  ));
}

const wiringFor = (root: string): Promise<string> =>
  fs.readFile(path.join(root, ".vendo/generated/remix-wiring.ts"), "utf8");

/** One slot's block in the EMITTED wiring file. Read back out of the artifact
 *  rather than off the splitter's return value: a port graded against the names
 *  its own producer is still holding in memory proves only that the producer
 *  agrees with itself. */
function wiredSlot(wiring: string, slot: string): { tools: Array<{ name: string; risk: string }>; holes: string[] } {
  const block = wiring.slice(wiring.indexOf(`\n  ${slot}: {`));
  const body = block.slice(0, block.indexOf("\n  },"));
  const holes = /holes: \{([^}]*)\}/u.exec(body)?.[1] ?? "";
  return {
    tools: [...body.matchAll(/name: "([^"]+)",\n\s*description: .*\n\s*inputSchema: .*\n\s*risk: "([^"]+)"/gu)]
      .map(([, name, risk]) => ({ name: name!, risk: risk! })),
    holes: holes.split(",").map((entry) => entry.split(":")[0]!.trim()).filter((entry) => entry !== ""),
  };
}

/** The names a port imports from the screen module — what it will ask the
 *  renderer to resolve. */
const screenImports = (source: string): string[] =>
  (/^import \{ ([^}]+) \} from "@vendo\/screen";/mu.exec(source)?.[1] ?? "")
    .split(",").map((name) => name.trim()).filter((name) => name !== "");

/** The data-hook zoo case on its own — the smallest host that exercises a shim,
 *  an envelope tool and a host-backed binding. */
async function dataHookRoot(): Promise<string> {
  const root = await temporaryRoot();
  await write(root, "src/app/page.tsx", `
    import { Remixable } from "${UI_CHROME}";
    import { RewardsPanel } from "../components/RewardsPanel";
    export default function Page() {
      return <Remixable><RewardsPanel accountId="a1" /></Remixable>;
    }
  `);
  // A REAL data hook, in the shape every SWR/react-query host writes: a hook
  // wrapping a fetch, with the key and the fetcher both literal in the source.
  // No plain function wearing a hook's name — that shape cannot exist in real
  // React, and a fixture that cannot exist is the counterparty being mocked.
  // It DECLARES the parameter its call site passes, for the same reason: a
  // zero-parameter hook called with an argument is host code that does not
  // compile, and the declaration is where the generated tool's input comes from.
  await write(root, "src/lib/api-client.ts",
    "export const api = { get: async (path: string) => ({ points: 10 }) };\n");
  await write(root, "src/lib/rewards.ts", `import useSWR from "swr";
import { api } from "./api-client";

const f = (url: string) => api.get(url);

export const useRewards = (accountId: string) => useSWR("/api/rewards", f);
`);
  await write(root, "src/components/RewardsPanel.tsx", `import { useRewards } from "../lib/rewards";

export function RewardsPanel({ accountId }: { accountId: string }) {
  const rewards = useRewards(accountId);
  return <section><h2>Rewards</h2><p>{rewards?.points ?? 0}</p></section>;
}
`);
  return root;
}

/** All six zoo cases behind one page, so one sync grades them together. */
async function zooRoot(): Promise<string> {
  const root = await temporaryRoot();
  await write(root, "src/app/page.tsx", `
    import { Remixable } from "${UI_CHROME}";
    import { Plain } from "../components/Plain";
    import { RewardsPanel } from "../components/RewardsPanel";
    import { BillRow } from "../components/BillRow";
    import { NpmDep } from "../components/NpmDep";
    import { SubHost } from "../components/SubHost";
    import { Broken } from "../components/Broken";
    export default function Page() {
      return (
        <main>
          <Remixable><Plain /></Remixable>
          <Remixable><RewardsPanel accountId="a1" /></Remixable>
          <Remixable><BillRow billId="b1" /></Remixable>
          <Remixable><NpmDep /></Remixable>
          <Remixable><SubHost /></Remixable>
          <Remixable><Broken /></Remixable>
        </main>
      );
    }
  `);

  // 1. plain — no data, no actions, and the host's own classes on the way through.
  await write(root, "src/components/Plain.tsx", `export function Plain() {
  return <section className="panel" style={{ padding: 8 }}><h2>Plain</h2><p>No data, no actions.</p></section>;
}
`);

  // 2. data-hook — the call site must survive verbatim.
  await write(root, "src/lib/api-client.ts",
    "export const api = { get: async (path: string) => ({ points: 10 }) };\n");
  await write(root, "src/lib/rewards.ts", `import useSWR from "swr";
import { api } from "./api-client";

const f = (url: string) => api.get(url);

export const useRewards = (accountId: string) => useSWR("/api/rewards", f);
`);
  await write(root, "src/components/RewardsPanel.tsx", `import { useRewards } from "../lib/rewards";

export function RewardsPanel({ accountId }: { accountId: string }) {
  const rewards = useRewards(accountId);
  return <section><h2>Rewards</h2><p>{rewards?.points ?? 0}</p></section>;
}
`);

  // 3. action — a handler that mutates.
  await write(root, "src/lib/billing.ts",
    "export async function payBill(billId: string) { return { paid: billId }; }\n");
  await write(root, "src/components/PayButton.tsx",
    "export function PayButton(props: { onClick: () => void }) { return <button onClick={props.onClick}>Pay</button>; }\n");
  await write(root, "src/components/BillRow.tsx", `import { payBill } from "../lib/billing";
import { PayButton } from "./PayButton";

export function BillRow({ billId }: { billId: string }) {
  return <section><h3>Bill</h3><PayButton onClick={() => payBill(billId)} /></section>;
}
`);

  // 4. npm-dep — never captured as source, always a hole.
  await write(root, "src/components/NpmDep.tsx", `import { FancyChart } from "fancy-chart";

export function NpmDep() {
  return <section><h2>Chart</h2><FancyChart /></section>;
}
`);

  // 5. sub-component — a host component resolved by name.
  await write(root, "src/components/charts/Sparkline.tsx",
    "export function Sparkline() { return <svg />; }\n");
  await write(root, "src/components/SubHost.tsx", `import { Sparkline } from "./charts/Sparkline";

export function SubHost() {
  return <section><h2>Trend</h2><Sparkline /></section>;
}
`);

  // 6. unsplittable — a browser global read in the COMPONENT's own body. The
  //    carver cuts declarations and subtrees, and this is neither: the read is
  //    the component's own line, so there is nothing to cut around it. (An
  //    unportable ELEMENT no longer refuses a component — the carver holes it.)
  await write(root, "src/components/Broken.tsx", `export function Broken() {
  return <section><p>{location.href}</p></section>;
}
`);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("the splitter", () => {
  it("splits the zoo: five ports plus one loud skip, and the skip does not stop the rest", async () => {
    const root = await zooRoot();

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.errors).toEqual([]);
    expect(result.captured).toEqual(["BillRow", "Broken", "NpmDep", "Plain", "RewardsPanel", "SubHost"]);

    // 1. plain — ports with no tools and no holes.
    const plain = await baselineFor(root, "Plain");
    expect(plain.ported).toBeDefined();
    expect(plain.ported?.tools).toEqual([]);
    expect(plain.ported?.holes).toEqual([]);
    expect(plain.ported?.source).toContain("export default Plain;");
    // The body is the host's, byte for byte — its classes included.
    expect(plain.ported?.source).toContain(`<section className="panel" style={{ padding: 8 }}>`);

    // 2. data-hook — the call site is preserved VERBATIM behind a generated shim.
    const rewards = await baselineFor(root, "RewardsPanel");
    expect(rewards.ported?.tools).toEqual(["rewards_panel_data"]);
    expect(rewards.ported?.holes).toEqual([]);
    expect(rewards.ported?.source).toContain("const rewards = useRewards(accountId);");
    // The shim is exactly as wide as the hook the host declared — the same law
    // as the write shim below. An open `...args` bag would let a remix call the
    // read with any arity, and it is also the declaration the generated tool's
    // input schema comes from.
    expect(rewards.ported?.source).toContain(`function useRewards(accountId: any) { return useQuery("rewards_panel_data")?.useRewards; }`);

    // 3. action — an intent, reachable only from a handler.
    const bill = await baselineFor(root, "BillRow");
    expect(bill.ported?.tools).toEqual(["bill_row_pay_bill"]);
    expect(bill.ported?.holes).toEqual(["PayButton"]);
    // The intent is exactly as wide as the call the component already made: one
    // named parameter, the host's own. An open `args` bag here would let a remix
    // call payBill with any arity and any values — a wider capability than the
    // component being ported ever had.
    expect(bill.ported?.source).toContain(`async function payBill(billId: any) { return tools.bill_row_pay_bill({ billId }); }`);
    expect(bill.ported?.source).toContain("onClick={() => payBill(billId)}");

    // 4. npm-dep — a hole, and its source is never captured.
    const npm = await baselineFor(root, "NpmDep");
    expect(npm.ported?.holes).toEqual(["FancyChart"]);
    expect(npm.subSources ?? {}).toEqual({});

    // 5. sub-component — a hole resolved by name.
    const sub = await baselineFor(root, "SubHost");
    expect(sub.ported?.holes).toEqual(["Sparkline"]);
    expect(sub.ported?.source).toContain(`import { Sparkline } from "@vendo/screen";`);

    // 6. unsplittable — no port, a loud report, and the other five still ship.
    const broken = await baselineFor(root, "Broken");
    expect(broken.ported).toBeUndefined();
    expect(broken.source).toContain("location.href");
    expect(result.warnings.filter((warning) => warning.includes("Broken"))).toEqual([
      expect.stringContaining(`reads the name "location"`),
    ]);

    // The wiring covers the five that split, and never the one that did not.
    const wiring = await wiringFor(root);
    for (const slot of ["Plain", "RewardsPanel", "BillRow", "NpmDep", "SubHost"]) {
      expect(wiring).toContain(`  ${slot}: {`);
    }
    expect(wiring).not.toContain("Broken");
    expect(wiring).toContain(`import { FancyChart } from "fancy-chart";`);
    expect(wiring).toContain(`import { Sparkline } from "../../src/components/charts/Sparkline";`);
  }, 120_000);

  it("every emitted port paints against exactly the surface the emitted wiring registers", async () => {
    const root = await zooRoot();

    await capturePins(root, path.join(root, ".vendo"));
    const wiring = await wiringFor(root);

    // The five that split, re-graded from what is ON DISK. Nothing here comes
    // from the splitter's return value: the port is read out of the baseline,
    // the tools and holes it is measured against are read out of the wiring
    // file, and both are the bytes a consumer gets. A port that imported a name
    // the wiring never registers fails here — that is the class that ships
    // green and paints nothing.
    for (const slot of ["BillRow", "NpmDep", "Plain", "RewardsPanel", "SubHost"]) {
      const ported = (await baselineFor(root, slot)).ported;
      expect(ported, slot).toBeDefined();
      const wired = wiredSlot(wiring, slot);

      // The three artifacts agree on the surface, name for name.
      expect(ported!.holes, slot).toEqual(wired.holes);
      expect(ported!.tools, slot).toEqual(wired.tools.map((tool) => tool.name));
      // Everything the port imports is either a registered hole or the two
      // fixtures of the dialect itself.
      const importable = new Set([...wired.holes, "useQuery", "tools"]);
      for (const name of screenImports(ported!.source)) expect([slot, name, importable.has(name)]).toEqual([slot, name, true]);

      const check = await checkComponentScreen({
        source: ported!.source,
        hostTools: wired.tools.map((tool) => ({ ...tool, description: `${tool.name} description` })),
        catalog: wired.holes,
        // The ONE spelled dialect both graders spread — the same one the
        // runtime floor derives off the row's `seed`. `ported` is what puts
        // `className` in the dialect, and `remix-port-dialect.test.ts` is the
        // seam that catches the two graders disagreeing.
        ...PORTED_SCREEN_DIALECT,
        runQuery: async () => null,
      });
      expect([slot, check.ok, check.issues.map((issue) => issue.message)], slot).toEqual([slot, true, []]);
    }
  }, 120_000);

  it("emits a host-backed wiring file whose tool binds the host's own function", async () => {
    const root = await dataHookRoot();

    await capturePins(root, path.join(root, ".vendo"));

    // The tool binds the FETCH the hook wraps — `api.get("/api/rewards")` — and
    // never the hook itself, which is not callable on a server at all.
    expect(await wiringFor(root)).toBe(`// Generated by \`vendo sync\` — do not edit. Regenerated on every sync.
// Hook it up in BOTH places — the server registers the tools, the provider
// renders the holes and shows the ✦ on ported components:
//   import { remixWiring } from "./.vendo/generated/remix-wiring";
//   createVendo({ remixWiring })                 // server
//   <VendoProvider remixWiring={remixWiring}>    // client
import { api } from "../../src/lib/api-client";

export const remixWiring = {
  RewardsPanel: {
    tools: {
      rewards_panel_data: {
        name: "rewards_panel_data",
        description: "Read the data the RewardsPanel remixable component renders.",
        inputSchema: { type: "object", properties: { accountId: { type: "string" } }, additionalProperties: false },
        risk: "read",
        execute: async () => ({ useRewards: await api.get("/api/rewards") }),
      },
    },
    holes: {},
  },
} as const;
`);
  }, 120_000);

  it("refuses a hook it cannot see a fetch through — there is nothing underneath to bind", async () => {
    const root = await dataHookRoot();
    // A real hook with NO fetch this can see through — the context shape. The
    // port would keep calling it, but there is nothing underneath to bind, and
    // the hook itself throws server-side. Refusing is the only honest outcome;
    // there is no fetcher here to guess at.
    await write(root, "src/lib/rewards.ts", `import { useContext } from "react";
import { RewardsContext } from "./rewards-context";

export const useRewards = () => useContext(RewardsContext);
`);
    await write(root, "src/lib/rewards-context.ts",
      "export const RewardsContext = { points: 0 } as any;\n");

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect((await baselineFor(root, "RewardsPanel")).ported).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("a React hook this cannot see a fetch through")]);
  }, 120_000);

  it("refuses a read whose hook declares a parameter the tool cannot carry — same law as the writes", async () => {
    const root = await dataHookRoot();
    // The read tool's input schema is the hook's own declared parameters — that
    // declaration is the allowlist the call site's live props are admitted
    // against. A parameter this cannot narrow (an object) is a boundary this
    // cannot write, and a boundary written as "anything" would be wider than
    // the call the component already makes.
    await write(root, "src/lib/rewards.ts", `import useSWR from "swr";
import { api } from "./api-client";

const f = (url: string) => api.get(url);

export const useRewards = (filter: { region: string }) => useSWR("/api/rewards", f);
`);
    await write(root, "src/components/RewardsPanel.tsx", `import { useRewards } from "../lib/rewards";

export function RewardsPanel({ accountId }: { accountId: string }) {
  const rewards = useRewards({ region: accountId });
  return <section><h2>Rewards</h2><p>{rewards?.points ?? 0}</p></section>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect((await baselineFor(root, "RewardsPanel")).ported).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("could not be narrowed to a signature")]);
  }, 120_000);

  it("never mistakes a render callback for a handler: a pure helper in .map() is refused, not made an intent", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { Ledger } from "../components/Ledger";
      export default function Page() { return <Remixable><Ledger /></Remixable>; }
    `);
    await write(root, "src/lib/money.ts", "export function formatUSD(cents: number) { return `$${cents}`; }\n");
    // The arrow inside .map() is not the component's own function either. Read as
    // a handler, `formatUSD` becomes an async write intent, every row paints a
    // Promise, and the gauntlet sees a perfectly legal screen — so nothing
    // refuses it. That silent wrong port is what this test exists to prevent.
    await write(root, "src/components/Ledger.tsx", `import { formatUSD } from "../lib/money";

export function Ledger() {
  return <ul>{[1, 2].map((n) => <li>{formatUSD(n)}</li>)}</ul>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect((await baselineFor(root, "Ledger")).ported).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining(`imports "../lib/money"`)]);
  }, 120_000);

  it("never mistakes a pure helper for a data read: a rest-parameter utility is refused, not made an envelope", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { Chip } from "../components/Chip";
      export default function Page() { return <Remixable><Chip /></Remixable>; }
    `);
    // `cn` is the classnames utility every host has. Read as a data fetch it
    // becomes an envelope field, returns undefined, and the component paints
    // with NO classes at all — a legal screen the gauntlet cannot fault. Its
    // rest parameter also walks straight past the needs-arguments gate, so this
    // is the shape that reaches an end user if the read rule is loose.
    await write(root, "src/lib/cn.ts", "export function cn(...parts: string[]) { return parts.join(' '); }\n");
    await write(root, "src/components/Chip.tsx", `import { cn } from "../lib/cn";

export function Chip({ tone }: { tone?: string }) {
  return <span className={cn("chip", tone)}>chip</span>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect((await baselineFor(root, "Chip")).ported).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining(`imports "../lib/cn"`)]);
  }, 120_000);

  it("carves a same-module unportable component into a hole the home half renders", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { TrendCard } from "../components/TrendCard";
      export default function Page() { return <Remixable><TrendCard /></Remixable>; }
    `);
    // The Maple shape: the card is portable, its hand-rolled chart is not — the
    // SVG never enters the dialect. The chart declaration goes HOME whole, with
    // the module-level helper it closes over, and the call site survives in the
    // port verbatim as a hole.
    await write(root, "src/components/TrendCard.tsx", `const WIDTH = 320;

function areaPath(series: number[]): string {
  return series.map((v, i) => (i === 0 ? "M" : "L") + i + "," + v).join("");
}

function MiniChart({ series }: { series: number[] }) {
  return <svg viewBox={"0 0 " + WIDTH + " 60"}><path d={areaPath(series)} /></svg>;
}

export function TrendCard() {
  const series = [1, 2, 3];
  return <section><h2>Trend</h2><MiniChart series={series} /></section>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));
    expect(result.warnings).toEqual([]);

    const card = await baselineFor(root, "TrendCard");
    expect(card.ported?.holes).toEqual(["MiniChart"]);
    expect(card.ported?.source).toContain("<MiniChart series={series} />");
    expect(card.ported?.source).not.toContain("<svg");
    expect(card.ported?.source).toContain(`import { MiniChart } from "@vendo/screen";`);

    // The home half: the host's own declaration, its closure, and an export.
    const home = await fs.readFile(path.join(root, ".vendo/generated/remix-holes/TrendCard.tsx"), "utf8");
    expect(home).toContain("function MiniChart({ series }: { series: number[] })");
    expect(home).toContain("function areaPath(series: number[]): string");
    expect(home).toContain("const WIDTH = 320;");
    expect(home).toContain("export { MiniChart };");
    expect(await wiringFor(root)).toContain(`import { MiniChart } from "./remix-holes/TrendCard";`);
    // MOVED, not copied: nothing left in the port reads the chart's helpers, so
    // they leave it — a dead module-level line still RUNS at boot, and one that
    // reads what only the host has (Intl, a browser global) takes the port down.
    expect(card.ported?.source).not.toContain("areaPath");
    expect(card.ported?.source).not.toContain("WIDTH");
  }, 120_000);

  it("carves an inline unportable subtree into a generated hole, its free variables becoming props", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { IconStrip } from "../components/IconStrip";
      export default function Page() { return <Remixable><IconStrip /></Remixable>; }
    `);
    // The QuickActions shape: inline SVG inside the component's own JSX, fed by
    // a module-level table. The subtree is cut at the outermost unportable
    // element; `icon` — the one name it reads from the component's own scope —
    // becomes the generated hole's prop.
    await write(root, "src/components/IconStrip.tsx", `const GLYPHS: Record<string, string> = { send: "M14 21" };

export function IconStrip() {
  const icons = [{ label: "Send", icon: "send" }];
  return (
    <div>
      {icons.map(({ label, icon }) => (
        <span key={label}>
          <svg viewBox="0 0 24 24"><path d={GLYPHS[icon] ?? ""} /></svg>
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));
    expect(result.warnings).toEqual([]);

    const strip = await baselineFor(root, "IconStrip");
    expect(strip.ported?.holes).toEqual(["IconStripSvg"]);
    expect(strip.ported?.source).toContain("<IconStripSvg icon={icon} />");
    expect(strip.ported?.source).not.toContain("<svg");

    const home = await fs.readFile(path.join(root, ".vendo/generated/remix-holes/IconStrip.tsx"), "utf8");
    expect(home).toContain("export function IconStripSvg(");
    expect(home).toContain("const GLYPHS");
    expect(home).toContain("<svg viewBox=\"0 0 24 24\">");
  }, 120_000);

  it("carves a hook the dialect cannot run home with the one element its value paints", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { CountCard } from "../components/CountCard";
      export default function Page() { return <Remixable><CountCard value={10} /></Remixable>; }
    `);
    // The NetWorthView shape: a same-module hook over browser APIs, called once
    // at the top of the component, its value painted by exactly one element.
    // The hook cannot leave the component body — React pins it there — so the
    // cut carries hook and element together, and the call's argument becomes
    // the hole's prop.
    await write(root, "src/components/CountCard.tsx", `"use client"
import { useEffect, useState } from "react";

function useCountUp(target: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setValue(target));
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return value;
}

export function CountCard({ value }: { value: number }) {
  const animated = useCountUp(value);
  return <section><h2>Total</h2><span>{animated}</span></section>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));
    expect(result.warnings).toEqual([]);

    const card = await baselineFor(root, "CountCard");
    expect(card.ported?.holes).toEqual(["CountCardCountUp"]);
    expect(card.ported?.source).toContain("<CountCardCountUp target={value} />");
    expect(card.ported?.source).not.toContain("requestAnimationFrame");
    expect(card.ported?.source).not.toContain("useCountUp");

    const home = await fs.readFile(path.join(root, ".vendo/generated/remix-holes/CountCard.tsx"), "utf8");
    // The host wrote a client component, and the cut half still is one: without
    // the directive, Next refuses the hooks the moment the wiring rides into a
    // server module's import graph.
    expect(home.startsWith(`"use client";`)).toBe(true);
    expect(home).toContain("function useCountUp(target: number): number");
    expect(home).toContain("export function CountCardCountUp(");
    expect(home).toContain("const animated = useCountUp(target);");
    expect(home).toContain("<span>{animated}</span>");
  }, 120_000);

  it("refuses the hook cut when its value paints more than one element — no guess ships", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { TwiceCard } from "../components/TwiceCard";
      export default function Page() { return <Remixable><TwiceCard /></Remixable>; }
    `);
    // The value feeds TWO elements, so no single subtree can carry the hook —
    // cutting either one changes what the other paints. The honest answer is
    // the usual loud refusal, naming the hook.
    await write(root, "src/components/TwiceCard.tsx", `import { useState } from "react";

function useNow(): number {
  const [now] = useState(() => performance.now());
  return now;
}

export function TwiceCard() {
  const now = useNow();
  return <section><span>{now}</span><small>{now}</small></section>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));

    expect((await baselineFor(root, "TwiceCard")).ported).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringContaining("useNow")]);
  }, 120_000);

  it("rewrites a plain <button> to the Kit Button, the host's class and style surviving", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { RangePicker } from "../components/RangePicker";
      export default function Page() { return <Remixable><RangePicker /></Remixable>; }
    `);
    await write(root, "src/components/RangePicker.tsx", `import { useState } from "react";

export function RangePicker() {
  const [range, setRange] = useState("1W");
  return (
    <div className="picker">
      {["1W", "1M"].map((option) => (
        <button key={option} type="button" className="chip" style={{ height: 28, cursor: "pointer", background: "#FFF" }} onClick={() => setRange(option)}>
          {option}
        </button>
      ))}
      <span>{range}</span>
    </div>
  );
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));
    expect(result.warnings).toEqual([]);

    const picker = await baselineFor(root, "RangePicker");
    // The host's inline style, mechanically narrowed to the paint allowlist —
    // the same law as the tag rewrite: `background` becomes `backgroundColor`
    // (a pure key rename; a value only a shorthand could smuggle is inert
    // there), and a key the allowlist does not carry is removed, never guessed
    // at. No value is ever inspected.
    expect(picker.ported?.source).toContain(
      `<Button key={option} className="chip" style={{ height: 28, backgroundColor: "#FFF" }} onClick={() => setRange(option)}>`,
    );
    expect(picker.ported?.source).toContain("</Button>");
    expect(picker.ported?.source).not.toContain("<button");
    expect(picker.ported?.source).toContain(`import { Button } from "@vendo/screen";`);
    expect(picker.ported?.holes).toEqual([]);
  }, 120_000);

  it("narrows a plain card's inline style with nothing else to carve — background is every host's word", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { PlainCard } from "../components/PlainCard";
      export default function Page() { return <Remixable><PlainCard /></Remixable>; }
    `);
    // No cuts, no buttons — just the one style key the paint allowlist spells
    // differently. The narrowing must not depend on the carver having anything
    // ELSE to do: a plain real card was refused for exactly this.
    await write(root, "src/components/PlainCard.tsx", `export function PlainCard() {
  return <article style={{ borderRadius: 16, background: "#fff" }}><p>Net worth</p></article>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"));
    expect(result.warnings).toEqual([]);

    const card = await baselineFor(root, "PlainCard");
    expect(card.ported?.source).toContain(`style={{ borderRadius: 16, backgroundColor: "#fff" }}`);
  }, 120_000);

  it("grades a props-dependent port with the host's own sample props, and lands them on the baseline", async () => {
    const root = await temporaryRoot();
    await write(root, "src/app/page.tsx", `
      import { Remixable } from "${UI_CHROME}";
      import { StatCard } from "../components/StatCard";
      export default function Page() { return <Remixable><StatCard total={7} /></Remixable>; }
    `);
    // The NetWorthView shape at its smallest: the paint depends on a prop, and
    // the host's own guard renders nothing without one. The gauntlet paints
    // with the registration's declared sample props — the host's own, never
    // invented — and they land on the baseline for the seed door to reuse.
    await write(root, "src/components/StatCard.tsx", `export function StatCard({ total }: { total?: number }) {
  if (total === undefined) return null;
  return <section><p>{total}</p></section>;
}
`);

    const result = await capturePins(root, path.join(root, ".vendo"), new Set(), undefined,
      (_file, slot) => (slot === "StatCard" ? { total: 7 } : undefined));
    expect(result.warnings).toEqual([]);

    const card = await baselineFor(root, "StatCard");
    expect(card.sampleProps).toEqual({ total: 7 });
    expect(card.ported).toBeDefined();
  }, 120_000);

  it("regrades on the next sync: a component that stops being clean loses its port", async () => {
    const root = await dataHookRoot();
    await capturePins(root, path.join(root, ".vendo"));
    expect((await baselineFor(root, "RewardsPanel")).ported).toBeDefined();

    await write(root, "src/components/RewardsPanel.tsx", `import { useRewards } from "../lib/rewards";

export function RewardsPanel({ accountId }: { accountId: string }) {
  const rewards = useRewards(accountId);
  return <section>{location.href}{rewards?.points ?? 0}</section>;
}
`);
    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.drifted).toEqual(["RewardsPanel"]);
    expect((await baselineFor(root, "RewardsPanel")).ported).toBeUndefined();
    expect(await wiringFor(root)).toContain("export const remixWiring = {\n} as const;");
  }, 120_000);
});
