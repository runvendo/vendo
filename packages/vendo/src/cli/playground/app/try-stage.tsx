/**
 * The product-stage backdrop (design canvas, variant A + the A× archetype
 * set): a deterministic CSS-skeleton "fake app" painted behind the open
 * overlay in the visitor's own brand tokens, so the try page reads as "your
 * app with the agent in it" instead of a white void.
 *
 * Rules, straight from the approved canvas:
 * - One of five archetypes (pickStageArchetype in try-boot.ts) — dashboard,
 *   finance, commerce, content, docs — all sharing the same skeleton
 *   primitives, tinted exclusively from the profile theme through the
 *   `--vendo-color-*` custom properties (the same color-mix derivations the
 *   canvas uses, so the shapes re-tint with any extracted theme).
 * - NO text pretending to be data: skeleton bars only, plus plausible
 *   nav/section labels (stageNavLabels + fixed archetype section headings).
 * - Purely decorative: aria-hidden, no focusables, nothing animated (so
 *   reduced-motion needs no special casing), sits under the overlay's own
 *   scrim + blur exactly like the canvas frames.
 *
 * Styling rides the house inline-style idiom with a themeCssVariables scope,
 * like try-refine and the old chips row.
 */
import type { VendoTheme } from "@vendoai/core";
import { themeCssVariables } from "@vendoai/ui";
import type { CSSProperties, ReactNode } from "react";
import type { StageArchetype } from "./try-boot.js";

/** Skeleton tint: text mixed into surface, the canvas `.sk` / `.sk.is-deep`. */
function mix(percent: number, into: "surface" | "bg" = "surface"): string {
  const base = into === "bg" ? "var(--vendo-color-background)" : "var(--vendo-color-surface)";
  return `color-mix(in srgb, var(--vendo-color-text) ${percent}%, ${base})`;
}

/** One skeleton bar (`.sk`). Width/height in px or CSS strings; `deep` is the
 *  canvas's darker tint for money-column / heading stand-ins. */
function Bar({ w, h, deep = false, r = 6, style }: {
  w: number | string;
  h: number | string;
  deep?: boolean;
  r?: number | string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        display: "block",
        flex: "none",
        width: w,
        height: h,
        borderRadius: r,
        background: mix(deep ? 17 : 9),
        ...style,
      }}
    />
  );
}

/** Uppercase section label (`.fin-label` / `.app-side-label` treatment). */
function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 650,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
        color: "var(--vendo-color-muted)",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** The brand mark: the extracted logo when the profile has one, otherwise a
 *  brand-initial tile in the accent tokens (the canvas `.fin-mark`). */
function BrandMark({ brandName, logoUrl, size = 24 }: { brandName: string; logoUrl: string | null; size?: number }) {
  if (logoUrl) return <img src={logoUrl} alt="" style={{ height: size - 2, width: "auto", display: "block" }} />;
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.29),
        background: "var(--vendo-color-accent)",
        color: "var(--vendo-color-accent-text)",
        display: "grid",
        placeItems: "center",
        fontSize: Math.round(size * 0.5),
        fontWeight: 650,
        flex: "none",
      }}
    >
      {brandName.trim().charAt(0).toUpperCase() || "A"}
    </span>
  );
}

function NavLinks({ labels, activeStyle, style }: { labels: string[]; activeStyle?: CSSProperties; style?: CSSProperties }) {
  return (
    <div style={{ display: "flex", gap: 4, fontSize: 13, color: "var(--vendo-color-muted)", ...style }}>
      {labels.map((label, index) => (
        <span
          key={label}
          style={{
            padding: "6px 10px",
            borderRadius: 6,
            ...(index === 0
              ? { color: "var(--vendo-color-text)", fontWeight: 650, background: mix(6, "bg"), ...activeStyle }
              : {}),
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

const CARD: CSSProperties = {
  border: "1px solid var(--vendo-color-border)",
  borderRadius: 14,
  background: "var(--vendo-color-surface)",
  padding: "16px 18px",
};

// ---------------------------------------------------------------------------
// The five stages
// ---------------------------------------------------------------------------

/** A×1 — nav + sidebar + stat cards + issues table. */
function DashboardStage({ brandName, logoUrl, navLabels }: StageContentProps) {
  const rowWidths = ["46%", "58%", "39%", "52%", "44%"];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--vendo-color-background)" }}>
      <nav style={{ display: "flex", alignItems: "center", gap: 22, padding: "0 20px", height: 52, borderBottom: "1px solid var(--vendo-color-border)", flexShrink: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 14, fontWeight: 650, letterSpacing: "-0.01em" }}>
          <BrandMark brandName={brandName} logoUrl={logoUrl} size={22} />
          {brandName}
        </span>
        <NavLinks labels={navLabels} />
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              display: "flex", alignItems: "center", gap: 8, width: 200, fontSize: 12.5,
              color: "var(--vendo-color-muted)", border: "1px solid var(--vendo-color-border)",
              borderRadius: 6, padding: "6px 10px", background: "var(--vendo-color-surface)",
            }}
          >
            Search
          </span>
          <Bar w={28} h={28} r="50%" deep />
        </div>
      </nav>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <aside style={{ width: 224, flexShrink: 0, background: "var(--vendo-color-surface)", borderRight: "1px solid var(--vendo-color-border)", padding: "16px 12px", overflow: "hidden" }}>
          <SectionLabel style={{ display: "block", margin: "0 8px 6px" }}>Workspace</SectionLabel>
          {navLabels.map((label, index) => (
            <div
              key={label}
              style={{
                fontSize: 13, padding: "6px 8px", borderRadius: 6,
                ...(index === 0 ? { background: mix(6), fontWeight: 650 } : { color: "var(--vendo-color-muted)" }),
              }}
            >
              {label}
            </div>
          ))}
          <SectionLabel style={{ display: "block", margin: "14px 8px 6px" }}>Projects</SectionLabel>
          {["78%", "62%", "70%"].map((width, index) => (
            <div key={index} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 8px" }}>
              <Bar w={8} h={8} r="50%" deep />
              <Bar w={width} h={10} />
            </div>
          ))}
        </aside>
        <main style={{ flex: 1, minWidth: 0, padding: "22px 26px", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
            <span style={{ fontSize: 17, fontWeight: 650, letterSpacing: "-0.015em" }}>{navLabels[0]}</span>
            <Bar w={52} h={10} />
            <Bar w={78} h={30} r={6} deep style={{ marginLeft: "auto" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 18 }}>
            {["64%", "42%", "55%"].map((width, index) => (
              <div key={index} style={{ ...CARD, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                <Bar w={44} h={22} r={7} deep />
                <Bar w={width} h={10} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, padding: "8px 10px", borderBottom: "1px solid var(--vendo-color-border)" }}>
            {["ID", "Title", "Status", "Owner"].map((heading, index) => (
              <SectionLabel key={heading} style={{ flex: index === 1 ? 1 : "0 0 90px" }}>{heading}</SectionLabel>
            ))}
          </div>
          {rowWidths.map((title, index) => (
            <div key={index} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 10px", borderBottom: "1px solid var(--vendo-color-border)" }}>
              <Bar w={38} h={10} style={{ flex: "0 0 90px", width: 38 }} />
              <div style={{ flex: 1 }}><Bar w={title} h={11} /></div>
              <Bar w={64} h={20} r={999} style={{ flex: "0 0 90px", width: 64 }} />
              <div style={{ display: "flex", alignItems: "center", gap: 7, flex: "0 0 90px" }}>
                <Bar w={20} h={20} r="50%" deep />
                <Bar w={52} h={10} />
              </div>
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}

/** A×2 — balance hero + transaction rows + spending donut. */
function FinanceStage({ brandName, logoUrl, navLabels }: StageContentProps) {
  const txns: Array<[string, string, number, boolean]> = [
    ["46%", "28%", 58, true], ["58%", "22%", 46, false], ["39%", "31%", 64, true], ["52%", "25%", 50, false],
    ["44%", "34%", 54, true], ["61%", "27%", 60, false], ["48%", "30%", 48, true], ["55%", "24%", 62, false],
    ["42%", "29%", 52, true], ["57%", "26%", 44, false], ["50%", "32%", 66, true],
  ];
  const legend = [76, 46, 26, 11];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--vendo-color-background)" }}>
      <nav style={{ display: "flex", alignItems: "center", gap: 26, height: 56, padding: "0 26px", borderBottom: "1px solid var(--vendo-color-border)", background: "var(--vendo-color-surface)", flexShrink: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 15, fontWeight: 650, letterSpacing: "-0.01em" }}>
          <BrandMark brandName={brandName} logoUrl={logoUrl} />
          {brandName}
        </span>
        <NavLinks labels={navLabels} activeStyle={{ background: mix(6) }} />
        <div style={{ marginLeft: "auto" }}><Bar w={28} h={28} r="50%" deep /></div>
      </nav>
      <main style={{ flex: 1, minHeight: 0, width: "min(920px, 100%)", margin: "0 auto", padding: "30px 24px", overflow: "hidden" }}>
        <section style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 24 }}>
          <SectionLabel style={{ fontSize: 11.5 }}>Total balance</SectionLabel>
          <Bar w={264} h={38} r={9} deep />
          <div style={{ display: "flex", gap: 10 }}>
            <Bar w={134} h={11} />
            <Bar w={88} h={11} />
          </div>
        </section>
        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14, alignItems: "start" }}>
          <section style={CARD}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, fontWeight: 650, marginBottom: 6 }}>
              Recent transactions
              <Bar w={52} h={10} />
            </div>
            {txns.map(([line, sub, amount, deep], index) => (
              <div key={index} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderTop: index === 0 ? "none" : `1px solid color-mix(in srgb, var(--vendo-color-border) 70%, transparent)` }}>
                <Bar w={30} h={30} r="50%" />
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                  <Bar w={line} h={11} />
                  <Bar w={sub} h={9} />
                </div>
                <Bar w={amount} h={12} deep={deep} />
              </div>
            ))}
          </section>
          <section style={CARD}>
            <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>Spending by category</div>
            <div
              style={{
                width: 148, height: 148, borderRadius: "50%", position: "relative", margin: "14px auto 16px",
                background: `conic-gradient(${mix(76)} 0 34%, ${mix(46)} 34% 58%, ${mix(26)} 58% 80%, ${mix(11)} 80% 100%)`,
              }}
            >
              <span style={{ position: "absolute", inset: "24%", borderRadius: "50%", background: "var(--vendo-color-surface)" }} />
            </div>
            {legend.map((tint, index) => (
              <div key={index} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0" }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, flex: "none", background: mix(tint) }} />
                <Bar w={[96, 78, 110, 86][index]!} h={10} />
                <Bar w={34} h={10} style={{ marginLeft: "auto" }} />
              </div>
            ))}
          </section>
        </div>
      </main>
    </div>
  );
}

/** A×3 — top nav + product grid + cart badge. */
function CommerceStage({ brandName, logoUrl, navLabels }: StageContentProps) {
  const cards: Array<[string, string, number[]]> = [
    ["70%", "32%", [80, 42, 14]], ["58%", "28%", [62, 24]], ["76%", "34%", [80, 42, 14, 30]], ["64%", "30%", [52, 18]],
    ["68%", "32%", [74, 36]], ["54%", "26%", [80, 42, 14]], ["72%", "36%", [58, 22]], ["60%", "30%", [70, 32, 12]],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--vendo-color-background)" }}>
      <nav style={{ display: "flex", alignItems: "center", gap: 36, height: 62, padding: "0 34px", borderBottom: "1px solid var(--vendo-color-border)", flexShrink: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 650, letterSpacing: "0.1em" }}>
          {logoUrl ? <BrandMark brandName={brandName} logoUrl={logoUrl} /> : null}
          {brandName}
        </span>
        <div style={{ display: "flex", gap: 24, fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 650, color: "var(--vendo-color-muted)" }}>
          {navLabels.map((label, index) => (
            <span key={label} style={{ padding: "22px 0", ...(index === 0 ? { color: "var(--vendo-color-text)", boxShadow: "inset 0 -2px 0 var(--vendo-color-text)" } : {}) }}>
              {label}
            </span>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 20, alignItems: "center" }}>
          <Bar w={18} h={18} r="50%" />
          <Bar w={18} h={18} r="50%" />
          <span style={{ position: "relative", display: "flex" }}>
            <Bar w={18} h={18} r={5} deep />
            <span style={{ position: "absolute", top: -6, right: -7, width: 12, height: 12, borderRadius: 999, background: "var(--vendo-color-accent)" }} />
          </span>
        </div>
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 34px 6px" }}>
        <span style={{ fontSize: 18, fontWeight: 650, letterSpacing: "-0.01em" }}>{navLabels[0]}</span>
        <Bar w={60} h={10} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {["Filter", "Sort"].map((label) => (
            <span key={label} style={{ border: "1px solid var(--vendo-color-border)", borderRadius: 999, padding: "6px 13px", fontSize: 12, color: "var(--vendo-color-muted)" }}>
              {label}
            </span>
          ))}
        </div>
      </div>
      <main style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "18px 16px", padding: "16px 34px", overflow: "hidden", flex: 1, minHeight: 0 }}>
        {cards.map(([title, price, swatches], index) => (
          <div key={index} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ width: "100%", aspectRatio: "1 / 1", borderRadius: 10, background: mix(7) }} />
            <Bar w={title} h={11} />
            <Bar w={price} h={10} />
            <div style={{ display: "flex", gap: 6 }}>
              {swatches.map((tint, swatchIndex) => (
                <span key={swatchIndex} style={{ width: 13, height: 13, borderRadius: "50%", border: "1px solid var(--vendo-color-border)", background: mix(tint) }} />
              ))}
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}

/** Feed cards + composer — the one archetype the canvas picker names without
 *  a rendered A× frame; built in the same idiom as its siblings. */
function ContentStage({ brandName, logoUrl, navLabels }: StageContentProps) {
  const posts: Array<[string, string[], boolean]> = [
    ["34%", ["96%", "88%", "52%"], true],
    ["42%", ["90%", "64%"], false],
    ["30%", ["94%", "82%", "46%"], true],
    ["38%", ["92%", "70%"], false],
    ["33%", ["96%", "84%", "58%"], true],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--vendo-color-background)" }}>
      <nav style={{ display: "flex", alignItems: "center", gap: 26, height: 56, padding: "0 26px", borderBottom: "1px solid var(--vendo-color-border)", background: "var(--vendo-color-surface)", flexShrink: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 15, fontWeight: 650, letterSpacing: "-0.01em" }}>
          <BrandMark brandName={brandName} logoUrl={logoUrl} />
          {brandName}
        </span>
        <NavLinks labels={navLabels} activeStyle={{ background: mix(6) }} />
        <div style={{ marginLeft: "auto" }}><Bar w={28} h={28} r="50%" deep /></div>
      </nav>
      <main style={{ flex: 1, minHeight: 0, width: "min(600px, 100%)", margin: "0 auto", padding: "26px 20px", overflow: "hidden", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...CARD, display: "flex", alignItems: "center", gap: 12, padding: "14px 16px" }}>
          <Bar w={36} h={36} r="50%" />
          <Bar w="100%" h={36} r={999} style={{ flex: 1, background: mix(4) }} />
          <Bar w={64} h={30} r={999} deep />
        </div>
        {posts.map(([name, lines, image], index) => (
          <div key={index} style={{ ...CARD, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Bar w={34} h={34} r="50%" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
                <Bar w={name} h={11} deep />
                <Bar w="18%" h={9} />
              </div>
            </div>
            {lines.map((width, lineIndex) => <Bar key={lineIndex} w={width} h={11} />)}
            {image ? <Bar w="100%" h={130} r={10} style={{ background: mix(7) }} /> : null}
            <div style={{ display: "flex", gap: 18, marginTop: 2 }}>
              <Bar w={40} h={9} />
              <Bar w={40} h={9} />
              <Bar w={40} h={9} />
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}

/** A×4 — page tree + block skeletons. */
function DocsStage({ brandName, logoUrl, navLabels }: StageContentProps) {
  const rows: Array<[string, boolean, boolean]> = [
    ["64%", true, false], ["52%", false, true], ["58%", false, true], ["48%", false, false],
    ["66%", false, false], ["44%", false, false], ["56%", false, false],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", background: "var(--vendo-color-background)" }}>
      <aside style={{ width: 252, flexShrink: 0, background: "var(--vendo-color-surface)", borderRight: "1px solid var(--vendo-color-border)", padding: "12px 8px", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 650, padding: "6px 10px", fontSize: 13.5 }}>
          <BrandMark brandName={brandName} logoUrl={logoUrl} size={20} />
          {brandName}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--vendo-color-muted)", fontSize: 13, padding: "6px 10px", margin: "8px 0 12px", borderRadius: 6, background: mix(4) }}>
          Search
        </div>
        <SectionLabel style={{ display: "block", margin: "4px 10px 6px" }}>{navLabels[0]}</SectionLabel>
        {rows.map(([width, active, child], index) => (
          <div
            key={index}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 6,
              paddingLeft: child ? 30 : 10, ...(active ? { background: mix(6) } : {}),
            }}
          >
            <Bar w={14} h={14} r={4} style={{ background: mix(active ? 14 : 9) }} />
            <Bar w={width} h={10} deep={active} />
          </div>
        ))}
        {navLabels.slice(1).map((label) => (
          <SectionLabel key={label} style={{ display: "block", margin: "14px 10px 6px" }}>{label}</SectionLabel>
        ))}
      </aside>
      <main style={{ flex: 1, minWidth: 0, padding: "44px 0", overflow: "hidden" }}>
        <div style={{ width: "min(620px, 90%)", margin: "0 auto", display: "flex", flexDirection: "column", gap: 13 }}>
          <Bar w={180} h={10} style={{ marginBottom: 17 }} />
          <Bar w={260} h={28} r={8} deep style={{ marginBottom: 13 }} />
          <Bar w="94%" h={12} />
          <Bar w="88%" h={12} />
          <Bar w="64%" h={12} />
          <div style={{ display: "flex", gap: 12, alignItems: "center", background: "var(--vendo-color-surface)", borderRadius: 8, padding: "15px 16px", margin: "7px 0" }}>
            <span style={{ width: 18, height: 18, borderRadius: 4, background: "color-mix(in srgb, var(--vendo-color-accent) 28%, var(--vendo-color-surface))", flex: "none" }} />
            <Bar w="72%" h={11} />
          </div>
          <Bar w="38%" h={16} deep style={{ margin: "15px 0 3px" }} />
          <Bar w="90%" h={12} />
          <Bar w="96%" h={12} />
          <Bar w="52%" h={12} />
          <Bar w="100%" h={130} r={8} style={{ margin: "7px 0" }} />
          <Bar w="30%" h={16} deep style={{ margin: "15px 0 3px" }} />
          <Bar w="86%" h={12} />
          <Bar w="74%" h={12} />
          <Bar w="92%" h={12} />
          <Bar w="60%" h={12} />
          <Bar w="34%" h={16} deep style={{ margin: "15px 0 3px" }} />
          <Bar w="88%" h={12} />
          <Bar w="48%" h={12} />
        </div>
      </main>
    </div>
  );
}

interface StageContentProps {
  brandName: string;
  logoUrl: string | null;
  navLabels: string[];
}

const STAGES: Record<StageArchetype, (props: StageContentProps) => ReactNode> = {
  dashboard: DashboardStage,
  finance: FinanceStage,
  commerce: CommerceStage,
  content: ContentStage,
  docs: DocsStage,
};

export function TryStage({ archetype, theme, brandName, logoUrl, navLabels }: StageContentProps & {
  archetype: StageArchetype;
  theme: VendoTheme;
}) {
  const Stage = STAGES[archetype];
  return (
    <div
      aria-hidden="true"
      data-vendo-try-stage={archetype}
      style={{
        ...themeCssVariables(theme),
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        color: "var(--vendo-color-text)",
        letterSpacing: "-0.011em",
        userSelect: "none",
        pointerEvents: "none",
      } as CSSProperties}
    >
      <Stage brandName={brandName} logoUrl={logoUrl} navLabels={navLabels} />
    </div>
  );
}
