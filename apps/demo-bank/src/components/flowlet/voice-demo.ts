/**
 * The Maple voice choreography (ENG-185 UI exploration). A scripted
 * `VoiceDriver` that exercises every stage transition against the REAL render
 * path — the generated views go through the sandbox exactly like agent output:
 *
 *   connect → listen → think → skeleton → view reveal → narrate → barge-in →
 *   act-tier approval (spoken yes, tappable) → critical approval (tap only) →
 *   reconnect blip → sign-off → settle back into the thread.
 *
 * No realtime backend: the WebRTC driver drops in behind the same seam later.
 */
import { createScriptedVoiceDriver, type VoiceDriver } from "@flowlet/shell";
import type { UINode } from "@flowlet/core";

const lateNightView: UINode = {
  id: "voice-late-night",
  kind: "generated",
  payload: {
    formatVersion: "flowlet-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["title", "table", "callout"] },
      { id: "title", component: "Text", props: { value: "Late-night orders — June" } },
      {
        id: "table",
        component: "Table",
        source: "prewired",
        props: {
          columns: [
            { key: "merchant", label: "Merchant" },
            { key: "date", label: "Date" },
            { key: "time", label: "Time" },
            { key: "amount", label: "Amount" },
          ],
          rows: [
            { merchant: "DoorDash", date: "Jun 12", time: "1:14 AM", amount: "$87.00" },
            { merchant: "Uber Eats", date: "Jun 18", time: "12:41 AM", amount: "$32.50" },
            { merchant: "DoorDash", date: "Jun 24", time: "1:02 AM", amount: "$25.75" },
            { merchant: "7-Eleven", date: "Jun 28", time: "2:19 AM", amount: "$18.20" },
          ],
        },
      },
      {
        id: "callout",
        component: "Callout",
        source: "prewired",
        props: {
          variant: "warning",
          text: "$163 after midnight this month — three times your May pace.",
        },
      },
    ],
  },
};

const refundView: UINode = {
  id: "voice-refund-receipt",
  kind: "generated",
  payload: {
    formatVersion: "flowlet-genui/v1",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", children: ["kv"] },
      {
        id: "kv",
        component: "KeyValue",
        source: "prewired",
        props: {
          title: "Transfer back to checking",
          rows: [
            { label: "From", value: "Spending buffer" },
            { label: "To", value: "Checking ···4021" },
            { label: "Amount", value: "$87.00", emphasis: true },
            { label: "When", value: "Instant" },
          ],
        },
      },
    ],
  },
};

export const mapleVoiceDriver: VoiceDriver = createScriptedVoiceDriver([
  // ---- enter ----
  { event: { type: "status", status: "connecting" } },
  { wait: 750 },
  { event: { type: "status", status: "listening" } },
  { wait: 900 },

  // ---- ask → think → skeleton → reveal → narrate ----
  { say: { id: "u1", role: "user", text: "What did I spend on late-night food this month?", wordMs: 150 } },
  { event: { type: "status", status: "thinking" } },
  { wait: 700 },
  { event: { type: "view-pending", id: "v1", name: "Late-night orders" } },
  { wait: 1400 },
  { event: { type: "view", id: "v1", node: lateNightView } },
  { event: { type: "status", status: "speaking" } },
  { wait: 200 },
  {
    say: {
      id: "a1",
      role: "assistant",
      text: "Four late-night orders — a hundred sixty-three dollars total. That one A.M. DoorDash run on the twelfth is the big one, eighty-seven dollars…",
      wordMs: 170,
    },
  },

  // ---- barge-in: the user cuts the narration off ----
  { event: { type: "caption", id: "a1b", role: "assistant", text: "and it looks like most of it lands after mid", final: true, interrupted: true } },
  { event: { type: "status", status: "listening" } },
  { wait: 350 },
  { say: { id: "u2", role: "user", text: "Okay okay — put me on blast in Slack next time I do that.", wordMs: 130 } },
  { event: { type: "status", status: "thinking" } },
  { wait: 800 },

  // ---- act-tier approval: spoken yes accepted (or tap — tap wins) ----
  {
    event: {
      type: "approval",
      id: "ap1",
      toolName: "SLACK_SEND_MESSAGE",
      input: { channel: "#accountability", message: "🌮 Yousef ordered delivery after midnight again." },
      tier: "act",
    },
  },
  { event: { type: "status", status: "speaking" } },
  {
    say: {
      id: "a2",
      role: "assistant",
      text: "I'll post to #accountability whenever a late-night order lands — should I set that up?",
      wordMs: 140,
    },
  },
  { event: { type: "status", status: "listening" } },
  { autoVoiceYes: { id: "ap1", after: 3200, sayText: "Yes, do it." } },
  {
    onResolution: {
      id: "ap1",
      approved: { id: "a3", role: "assistant", text: "Done. Your next midnight snack gets published.", wordMs: 140 },
      declined: { id: "a3", role: "assistant", text: "Fair enough — no blasting.", wordMs: 140 },
    },
  },
  { wait: 500 },

  // ---- critical approval: voice announces, only the hand confirms ----
  { say: { id: "u3", role: "user", text: "And move that eighty-seven dollars back to checking.", wordMs: 135 } },
  { event: { type: "status", status: "thinking" } },
  { wait: 800 },
  {
    event: {
      type: "approval",
      id: "ap2",
      toolName: "transfer_funds",
      input: { from: "Spending buffer", to: "Checking ···4021", amount: "$87.00" },
      tier: "critical",
    },
  },
  { event: { type: "status", status: "speaking" } },
  {
    say: {
      id: "a4",
      role: "assistant",
      text: "This one moves money, so I need you to confirm it on screen.",
      wordMs: 140,
    },
  },
  { event: { type: "status", status: "listening" } },
  {
    onResolution: {
      id: "ap2",
      approved: { id: "a5", role: "assistant", text: "Confirmed — eighty-seven dollars back in checking.", wordMs: 140 },
      declined: { id: "a5", role: "assistant", text: "Left it where it is.", wordMs: 140 },
    },
  },
  { event: { type: "view", id: "v2", node: refundView } },
  // Linger: room to scroll between the two views and feel the focus/blur
  // handoff before the session winds down.
  { wait: 7000 },

  // ---- a network blip mid-session, then recovery ----
  { event: { type: "status", status: "reconnecting", message: "Voice dropped — reconnecting…" } },
  { wait: 1900 },
  { event: { type: "status", status: "listening" } },
  { wait: 700 },

  // ---- sign-off → the stage settles back into the thread ----
  { say: { id: "u4", role: "user", text: "That's all, thanks.", wordMs: 140 } },
  { event: { type: "status", status: "speaking" } },
  { say: { id: "a6", role: "assistant", text: "Talk soon.", wordMs: 150 } },
  { wait: 400 },
  { event: { type: "status", status: "ended" } },
]);
