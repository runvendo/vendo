// Author the director-mode script: the M1 build choreography with a real,
// interactive micro-app (nudge buttons, working filter, animated chart) whose
// component sources ship inside the script and mount in the actual jail.
// Client logos are inlined as data URIs (the jail's CSP allows img-src data: only).
// Usage: node scripts/build-director-script.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("apps/demo-accounting/public/vendo-director/script.json");

async function dataUri(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const type = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  const bytes = Buffer.from(await response.arrayBuffer());
  return `data:${type};base64,${bytes.toString("base64")}`;
}

const favicon = domain => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

const logos = {
  bluebottle: `data:image/jpeg;base64,${readFileSync(resolve("apps/demo-accounting/public/logos/bluebottle.png")).toString("base64")}`,
  linear: await dataUri(favicon("linear.app")),
  sweetgreen: await dataUri(favicon("sweetgreen.com")),
  equinox: await dataUri(favicon("equinox.com")),
  taskrabbit: await dataUri(favicon("taskrabbit.com")),
  gusto: await dataUri(favicon("gusto.com")),
  adp: await dataUri(favicon("adp.com")),
  bofa: await dataUri(favicon("bankofamerica.com")),
};

// ---------------------------------------------------------------------------
// The generated micro-app, in three staged components (each morphs in as its
// source "arrives"). Porcelain Ledger tokens hardcoded to match the theme.
// ---------------------------------------------------------------------------

const heroSource = `
import * as React from "react";
const S = { ink: "#111111", soft: "#46443f", faint: "#908c85", line: "#ecebe8", green: "#1e7f53", greenBg: "#e7f4ee", amber: "#a16207", amberBg: "#faf3e3" };
export default function ChaseHero() {
  const [now, setNow] = React.useState(8);
  React.useEffect(() => {
    let v = 0;
    const t = setInterval(() => { v += 1; setNow(v); if (v >= 8) clearInterval(t); }, 70);
    return () => clearInterval(t);
  }, []);
  const tile = (label, value, sub) => (
    <div style={{ flex: 1, border: "1px solid " + S.line, borderRadius: 10, padding: "10px 12px", background: "#fff" }}>
      <div style={{ fontSize: 11.5, color: S.soft }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 650, color: S.ink, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: S.faint }}>{sub}</div>
    </div>
  );
  return (
    <div style={{ fontFamily: "Inter, system-ui", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: "#15573a", background: S.greenBg, borderRadius: 999, padding: "3px 10px" }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: S.green }} />
          every morning · 8:00
        </span>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        {tile("Clients behind", now, "of 12 active clients")}
        {tile("Docs outstanding", 21, "across all engagements")}
        {tile("Next deadline", "2d", "Blue Bottle Coffee · Jul 18")}
      </div>
    </div>
  );
}
`;

const listSource = `
import * as React from "react";
const S = { ink: "#111111", soft: "#46443f", faint: "#908c85", line: "#ecebe8", green: "#1e7f53", greenBg: "#e7f4ee", red: "#b0473a", redBg: "#fbede9", amber: "#a16207", amberBg: "#faf3e3" };
const CLIENTS = [
  { name: "Blue Bottle Coffee", logo: "${logos.bluebottle}", missing: "W-2, 1099-NEC, Receipts", due: "Jul 18", days: 2 },
  { name: "Linear", logo: "${logos.linear}", missing: "Bank statements (2025)", due: "Jul 19", days: 3 },
  { name: "Sweetgreen", logo: "${logos.sweetgreen}", missing: "1099-NEC, W-2", due: "Aug 6", days: 21 },
  { name: "Equinox", logo: "${logos.equinox}", missing: "Bank statements (2025), W-2", due: "Aug 10", days: 25 },
  { name: "TaskRabbit", logo: "${logos.taskrabbit}", missing: "1099-NEC, Receipts", due: "Aug 14", days: 29 },
];
export default function ChaseList() {
  const [nudged, setNudged] = React.useState({});
  const [filter, setFilter] = React.useState("all");
  const [flash, setFlash] = React.useState(null);
  const nudge = name => {
    setNudged(prev => ({ ...prev, [name]: true }));
    setFlash(name);
    setTimeout(() => setFlash(current => (current === name ? null : current)), 1800);
  };
  const nudgeAll = () => {
    CLIENTS.forEach((c, i) => setTimeout(() => nudge(c.name), i * 220));
  };
  const rows = CLIENTS.filter(c => filter === "all" ? true : filter === "urgent" ? c.days <= 7 : nudged[c.name]);
  const seg = (id, label) => (
    <button onClick={() => setFilter(id)} style={{ border: 0, cursor: "pointer", fontSize: 11.5, fontWeight: 600, padding: "4px 10px", borderRadius: 7, background: filter === id ? "#111" : "transparent", color: filter === id ? "#fff" : S.soft }}>{label}</button>
  );
  return (
    <div style={{ fontFamily: "Inter, system-ui", border: "1px solid " + S.line, borderRadius: 12, background: "#fff", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid " + S.line }}>
        <div style={{ display: "flex", gap: 2, background: "#f4f3f1", borderRadius: 9, padding: 2 }}>
          {seg("all", "All")}{seg("urgent", "Due this week")}{seg("nudged", "Emailed")}
        </div>
        <button onClick={nudgeAll} style={{ border: 0, cursor: "pointer", fontSize: 12, fontWeight: 600, padding: "6px 12px", borderRadius: 8, background: "#111", color: "#fff" }}>Email all</button>
      </div>
      {rows.map(c => (
        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderTop: "1px solid #f0efec", fontSize: 12.5 }}>
          <img src={c.logo} width="26" height="26" style={{ borderRadius: 7, border: "1px solid " + S.line, padding: 2, background: "#fff" }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, color: S.ink }}>{c.name}</div>
            <div style={{ fontSize: 11, color: S.faint }}>Missing: {c.missing} · {c.due}</div>
          </div>
          <span style={{ fontSize: 10.5, fontWeight: 600, padding: "2px 8px", borderRadius: 999, color: c.days <= 7 ? S.red : c.days <= 21 ? S.amber : S.soft, background: c.days <= 7 ? S.redBg : c.days <= 21 ? S.amberBg : "#f0efec" }}>{c.days}d</span>
          {nudged[c.name] ? (
            <span style={{ fontSize: 11.5, fontWeight: 600, color: S.green, minWidth: 64, textAlign: "center" }}>{flash === c.name ? "Sent ✓" : "Emailed"}</span>
          ) : (
            <button onClick={() => nudge(c.name)} style={{ minWidth: 64, border: "1px solid " + S.line, cursor: "pointer", fontSize: 11.5, fontWeight: 600, padding: "5px 0", borderRadius: 8, background: "#fff", color: S.ink }}>Email</button>
          )}
        </div>
      ))}
      {rows.length === 0 ? <div style={{ padding: 16, fontSize: 12, color: S.faint }}>Nothing here yet.</div> : null}
    </div>
  );
}
`;

const arrivalsSource = `
import * as React from "react";
const ARRIVALS = [
  { client: "Equinox", doc: "Payroll summary", via: "Gusto", logo: "${logos.gusto}", when: "2h ago" },
  { client: "Linear", doc: "Bank statements (H1)", via: "Bank of America", logo: "${logos.bofa}", when: "yesterday" },
  { client: "Sweetgreen", doc: "Payroll summary (Q2)", via: "ADP", logo: "${logos.adp}", when: "Monday" },
];
export default function ChaseArrivals() {
  return (
    <div style={{ fontFamily: "Inter, system-ui", border: "1px solid #ecebe8", borderRadius: 12, background: "#fff", overflow: "hidden" }}>
      <div style={{ padding: "10px 12px", fontSize: 12, fontWeight: 600, color: "#46443f", borderBottom: "1px solid #ecebe8" }}>Latest arrivals</div>
      {ARRIVALS.map(a => (
        <div key={a.client + a.doc} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: "1px solid #f0efec", fontSize: 12 }}>
          <img src={a.logo} width="22" height="22" style={{ borderRadius: 6, border: "1px solid #ecebe8", padding: 2, background: "#fff" }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <span style={{ fontWeight: 600, color: "#111" }}>{a.client}</span>
            <span style={{ color: "#46443f" }}> uploaded {a.doc}</span>
            <span style={{ color: "#908c85" }}> · via {a.via}</span>
          </div>
          <span style={{ fontSize: 10.5, color: "#908c85", flex: "none" }}>{a.when}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 12px", borderTop: "1px solid #ecebe8", background: "#fbfbfa", fontSize: 11.5, color: "#15573a", fontWeight: 600 }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: "#1e7f53" }} />
        Next chase — tomorrow 8:00 · 5 clients get a reminder
      </div>
    </div>
  );
}
`;

// ---------------------------------------------------------------------------
// Tree payloads: the same tree streamed four times, sources arriving in
// stages so each section morphs out of its skeleton (FluidReveal).
// ---------------------------------------------------------------------------

const NODES = [
  { id: "root", component: "Stack", props: { gap: 14 }, children: ["hero", "list", "arrivals"] },
  { id: "hero", component: "ChaseHero", source: "generated" },
  { id: "list", component: "ChaseList", source: "generated" },
  { id: "arrivals", component: "ChaseArrivals", source: "generated" },
];

const view = (streaming, components) => ({
  type: "data-vendo-view",
  id: "vendo-view:app_director",
  data: {
    appId: "app_director",
    payload: {
      formatVersion: "vendo-genui/v1",
      name: "Document chases",
      root: "root",
      ...(streaming ? { streaming: true } : {}),
      nodes: NODES,
      ...(components ? { components } : {}),
    },
  },
});

const cue = (delay, chunk) => ({ delay, chunk });

const script = {
  turns: [
    {
      cues: [
        cue(0, { type: "start" }),
        cue(100, { type: "start-step" }),
        // Beat: reading the firm's data.
        cue(400, { type: "tool-input-start", toolCallId: "call_deadlines", toolName: "host_listDeadlines" }),
        cue(400, { type: "tool-input-available", toolCallId: "call_deadlines", toolName: "host_listDeadlines", input: {} }),
        cue(1200, { type: "tool-output-available", toolCallId: "call_deadlines", output: { ok: true } }),
        cue(300, { type: "tool-input-start", toolCallId: "call_docs", toolName: "host_listClients" }),
        cue(300, { type: "tool-input-available", toolCallId: "call_docs", toolName: "host_listClients", input: { filter: "missing_docs" } }),
        cue(900, { type: "tool-output-available", toolCallId: "call_docs", output: { ok: true } }),
        // Beat: building — the view forms in stages.
        cue(400, { type: "tool-input-start", toolCallId: "call_build", toolName: "vendo_apps_create" }),
        cue(300, { type: "tool-input-available", toolCallId: "call_build", toolName: "vendo_apps_create", input: { prompt: "document chases" } }),
        cue(700, view(true, undefined)),
        cue(1500, view(true, { ChaseHero: heroSource })),
        cue(2100, view(true, { ChaseHero: heroSource, ChaseList: listSource })),
        cue(1900, view(false, { ChaseHero: heroSource, ChaseList: listSource, ChaseArrivals: arrivalsSource })),
        cue(700, { type: "tool-output-available", toolCallId: "call_build", output: { appId: "app_director" } }),
        // Beat: the Slack wire — creation first, consent from the run.
        cue(700, { type: "tool-input-start", toolCallId: "call_slack", toolName: "slack_SLACK_SEND_MESSAGE" }),
        cue(300, { type: "tool-input-available", toolCallId: "call_slack", toolName: "slack_SLACK_SEND_MESSAGE", input: { channel: "#team", message: "Blue Bottle Coffee uploaded W-2 — 4 of 6 in", trigger: "whenever a client uploads a document" } }),
        cue(300, { type: "data-vendo-approval", id: "risk:call_slack", data: { toolCallId: "call_slack", risk: "write" } }),
        cue(600, { type: "tool-approval-request", approvalId: "appr_slack", toolCallId: "call_slack" }),
        cue(200, { type: "finish-step" }),
        cue(50, { type: "finish" }),
      ],
    },
    {
      cues: [
        cue(0, { type: "start" }),
        cue(100, { type: "start-step" }),
        cue(800, { type: "tool-output-available", toolCallId: "call_slack", output: { ok: true, channel: "#team" } }),
        cue(400, { type: "text-start", id: "txt_done" }),
        cue(150, { type: "text-delta", id: "txt_done", delta: "Your Document chases app is live — " }),
        cue(170, { type: "text-delta", id: "txt_done", delta: "it checks every morning at 8:00, emails whoever's behind, " }),
        cue(170, { type: "text-delta", id: "txt_done", delta: "and #team hears the moment anything comes in." }),
        cue(120, { type: "text-end", id: "txt_done" }),
        cue(100, { type: "finish-step" }),
        cue(50, { type: "finish" }),
      ],
    },
  ],
};

writeFileSync(OUT, JSON.stringify(script, null, 2));
console.log(`wrote ${OUT} (${JSON.stringify(script).length} bytes)`);
