/**
 * Lane D evidence capture page (throwaway, untracked — the committed copy lives
 * in docs/superpowers/evidence/2026-08-03-ui-redesign/lane-d/).
 *
 * A host page with the real VendoOverlay on the real chrome stylesheet. The
 * conversation runs on the shipped ScriptedTransport (director mode) so a
 * multi-step turn is deterministic and paced for video; approvals come from the
 * package's own wire fixture, proxied by the vite config.
 */
import type { UIMessageChunk, VendoTheme } from "../src/index.js";
import { ScriptedTransport, VendoProvider, createVendoClient, type DirectorScript, type ToolMetaMap } from "../src/index.js";
import { VendoOverlay, WaitingQueue } from "../src/chrome/index.js";
import { createRoot } from "react-dom/client";

const mapleTheme: Partial<VendoTheme> = {
  colors: { background: "#f7f7f5", surface: "#ffffff", text: "#12241c", accent: "#1f7a4d" },
  radius: { small: 8, medium: 14, large: 22 },
};

const toolMeta: ToolMetaMap = {
  host_list_transactions: { label: "Reading your transactions" },
  host_list_accounts: { label: "Checking your accounts" },
  host_categorize_spending: { label: "Grouping your spending" },
  host_email_send: { label: "Send email" },
};

const cue = (delay: number, chunk: UIMessageChunk) => ({ delay, chunk });
const step = (id: string, tool: string, hold: number) => [
  cue(300, { type: "tool-input-available", toolCallId: id, toolName: tool, input: {}, dynamic: true } as UIMessageChunk),
  cue(hold, { type: "tool-output-available", toolCallId: id, output: { rows: 142 }, dynamic: true } as UIMessageChunk),
];

const script: DirectorScript = {
  turns: [{
    cues: [
      cue(200, { type: "start" } as UIMessageChunk),
      cue(200, { type: "text-start", id: "t1" } as UIMessageChunk),
      cue(200, { type: "text-delta", id: "t1", delta: "Pulling July together — a few passes." } as UIMessageChunk),
      cue(200, { type: "text-end", id: "t1" } as UIMessageChunk),
      ...step("c1", "host_list_transactions", 2_600),
      ...step("c2", "host_list_accounts", 2_600),
      ...step("c3", "host_categorize_spending", 2_800),
      cue(300, { type: "text-start", id: "t2" } as UIMessageChunk),
      cue(200, { type: "text-delta", id: "t2", delta: "Dining was $412 in July — 18% under June." } as UIMessageChunk),
      cue(200, { type: "text-end", id: "t2" } as UIMessageChunk),
      cue(200, { type: "finish" } as UIMessageChunk),
    ],
  }],
};

const client = createVendoClient({ baseUrl: "/api/vendo" });

function Page() {
  return (
    <VendoProvider client={client} theme={mapleTheme} tools={toolMeta} transport={new ScriptedTransport(script)}>
      <main>
        <h1>Maple</h1>
        <p>Checking · 8321 — $12,480.55</p>
        <section id="strip">
          <WaitingQueue />
        </section>
      </main>
      <VendoOverlay />
    </VendoProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
