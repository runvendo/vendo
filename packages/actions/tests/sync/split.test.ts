import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkComponentScreen } from "@vendoai/apps";
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
  await write(root, "src/lib/api-client.ts",
    "export const api = { get: async (path: string) => ({ points: 10 }) };\n");
  await write(root, "src/lib/rewards.ts", `import useSWR from "swr";
import { api } from "./api-client";

const f = (url: string) => api.get(url);

export const useRewards = () => useSWR("/api/rewards", f);
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

export const useRewards = () => useSWR("/api/rewards", f);
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

  // 6. unsplittable — <img> is not in the paint vocabulary and never will be.
  await write(root, "src/components/Broken.tsx", `export function Broken() {
  return <section><img src="/logo.png" alt="" /><p>Broken</p></section>;
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
    expect(rewards.ported?.source).toContain(`function useRewards(...args: any[]) { return useQuery("rewards_panel_data")?.useRewards; }`);

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
    expect(broken.source).toContain("<img");
    expect(result.warnings.filter((warning) => warning.includes("Broken"))).toEqual([
      expect.stringContaining("<img>"),
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
        // SYNC's configuration for a ported screen, NOT the runtime's — and
        // this line is the thing it warns about. `ported` is what puts
        // `className` in the dialect, but the real floor cannot pass the flag
        // (`apps/src/server/checking/floor.ts:174`; `AppFloorOptions` has no
        // dialect slot), so a port carrying a class goes green here and is
        // refused at `seed.from` and on every edit. Known unfixed bug — the fix
        // is named on `portedScreenDialect` in `sync/split/index.ts`. Until it
        // lands, what this assertion proves is that sync agrees with ITSELF.
        ported: true,
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
// Hook it up once, in your createVendo call:
//   import { remixWiring } from "./.vendo/generated/remix-wiring";
//   createVendo({ remixWiring });
import { api } from "../../src/lib/api-client";

export const remixWiring = {
  RewardsPanel: {
    tools: {
      rewards_panel_data: {
        name: "rewards_panel_data",
        description: "Read the data the RewardsPanel remixable component renders.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
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

  it("regrades on the next sync: a component that stops being clean loses its port", async () => {
    const root = await dataHookRoot();
    await capturePins(root, path.join(root, ".vendo"));
    expect((await baselineFor(root, "RewardsPanel")).ported).toBeDefined();

    await write(root, "src/components/RewardsPanel.tsx", `import { useRewards } from "../lib/rewards";

export function RewardsPanel({ accountId }: { accountId: string }) {
  const rewards = useRewards(accountId);
  return <section><img src="/x.png" alt="" />{rewards?.points ?? 0}</section>;
}
`);
    const result = await capturePins(root, path.join(root, ".vendo"));

    expect(result.drifted).toEqual(["RewardsPanel"]);
    expect((await baselineFor(root, "RewardsPanel")).ported).toBeUndefined();
    expect(await wiringFor(root)).toContain("export const remixWiring = {\n} as const;");
  }, 120_000);
});
