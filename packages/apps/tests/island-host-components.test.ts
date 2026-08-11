import { describe, expect, it } from "vitest";
import { ambientKitEquivalent, prepareIslands } from "../src/server/checking/islands.js";

/**
 * Rematch gate 2026-07-25: 17+ Cadence and several Maple creates burned every
 * repair round on islands referencing
 * host catalog components (<CadenceStatusBadge>, <MapleSparkline>,
 * <MapleSkeleton>) that can never resolve in the sandbox. (V4 removed the
 * second source of these — the non-ambient legacy primitives — by making the
 * built-in vocabulary a subset of the ambient Kit; host names are the only
 * offenders left.) The create contract warns about this, but the repair prompt
 * only carried a generic issue naming the WHOLE ambient list — no concrete
 * substitution — so repair reproduced the class instead of fixing it. Each
 * offending tag now gets its own teaching issue that names the ambient Kit
 * equivalent (or, for loading placeholders, the loading-state advice).
 * Detection is static (tag scan against catalog + non-ambient tree names) —
 * never dependent on the smoke worker.
 */

const island = (body: string): Record<string, string> => ({
  Panel: `export default function Panel() {\n  return (\n    <Stack>${body}</Stack>\n  );\n}\n`,
});

const prepare = (body: string, hostComponents: string[] = []) =>
  prepareIslands(island(body), undefined, hostComponents);

describe("ambientKitEquivalent", () => {
  it("maps host status/badge components to EnumBadge", () => {
    expect(ambientKitEquivalent("CadenceStatusBadge")).toBe("EnumBadge");
    expect(ambientKitEquivalent("MapleStatusPill")).toBe("EnumBadge");
  });

  it("maps by ambient-name suffix (MapleSparkline → Sparkline, CadenceDocProgress → Progress)", () => {
    expect(ambientKitEquivalent("MapleSparkline")).toBe("Sparkline");
    expect(ambientKitEquivalent("CadenceDocProgress")).toBe("Progress");
    expect(ambientKitEquivalent("AcmeDataTable")).toBe("DataTable");
    expect(ambientKitEquivalent("HostDonutChart")).toBe("DonutChart");
  });

  it("maps common host-component vocabulary to the closest Kit name", () => {
    expect(ambientKitEquivalent("MapleTable")).toBe("DataTable");
    // V4 — Card is a Kit component now, so a host "…Card" maps to Card itself
    // (the suffix rule) instead of being redirected at Surface.
    expect(ambientKitEquivalent("MapleCard")).toBe("Card");
    expect(ambientKitEquivalent("MapleMetricTile")).toBe("Stat");
    expect(ambientKitEquivalent("CadenceAlertBanner")).toBe("Callout");
  });

  it("returns undefined for loading placeholders and unmappable names", () => {
    expect(ambientKitEquivalent("Skeleton")).toBeUndefined();
    expect(ambientKitEquivalent("CadenceQuantumFlux")).toBeUndefined();
  });
});

describe("prepareIslands — host components inside islands teach the substitution", () => {
  it("names the ambient Kit equivalent for a host catalog component (the H17-H29 Cadence class)", async () => {
    const prepared = await prepare("<CadenceStatusBadge status=\"late\" />", ["CadenceStatusBadge"]);
    expect(prepared.issues).toHaveLength(1);
    expect(prepared.issues[0]).toContain("<CadenceStatusBadge> renders on the host page and cannot exist inside an island");
    expect(prepared.issues[0]).toContain("ambient Kit equivalent (EnumBadge)");
    expect(prepared.issues[0]).toContain("move it to a tree node");
  });

  it("suggests Sparkline for <MapleSparkline> (the H14 Maple class)", async () => {
    const prepared = await prepare("<MapleSparkline points={[]} />", ["MapleSparkline"]);
    expect(prepared.issues).toHaveLength(1);
    expect(prepared.issues[0]).toContain("ambient Kit equivalent (Sparkline)");
  });

  it("teaches the loading-state substitution for a host loading placeholder", async () => {
    const prepared = await prepare("<MapleSkeleton />", ["MapleSkeleton"]);
    expect(prepared.issues).toHaveLength(1);
    expect(prepared.issues[0]).toContain("<MapleSkeleton> renders on the host page and cannot exist inside an island");
    expect(prepared.issues[0]).toContain("loading");
  });

  it("names the Kit equivalent for host table/card components", async () => {
    const prepared = await prepare("<MapleCard><MapleTable rows={[]} /></MapleCard>", ["MapleCard", "MapleTable"]);
    expect(prepared.issues).toHaveLength(2);
    expect(prepared.issues.join("\n")).toContain("ambient Kit equivalent (DataTable)");
    expect(prepared.issues.join("\n")).toContain("ambient Kit equivalent (Card)");
  });

  /** V4 — a built-in name inside an island is FINE now: every wire built-in is
   *  also an ambient Kit name, so <DataTable>/<Card> render in the sandbox. */
  it("says nothing about a built-in name inside an island", async () => {
    const prepared = await prepare("<Card><DataTable rows={[]} /></Card>");
    expect(prepared.issues).toEqual([]);
  });

  it("emits one teaching issue per offending tag", async () => {
    const prepared = await prepare(
      "<CadenceStatusBadge /><MapleSkeleton />",
      ["CadenceStatusBadge", "MapleSkeleton"],
    );
    expect(prepared.issues).toHaveLength(2);
  });

  it("keeps ambient Kit names clean inside islands", async () => {
    const prepared = await prepare(
      "<EnumBadge value=\"ok\" /><DataTable rows={[]} /><Stat label=\"x\" value=\"1\" /><Sparkline points={[]} />",
      ["CadenceStatusBadge"],
    );
    expect(prepared.issues).toEqual([]);
  });

  it("keeps a locally-declared component of the same name clean (the local binding wins)", async () => {
    const source = {
      Panel: "function CadenceStatusBadge() { return <Badge value=\"ok\" />; }\nexport default function Panel() {\n  return <CadenceStatusBadge />;\n}\n",
    };
    const prepared = await prepareIslands(source, undefined, ["CadenceStatusBadge"]);
    expect(prepared.issues).toEqual([]);
  });
});
