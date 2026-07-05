import type { FlowletUIMessage } from "@flowlet/core";
import { toolAction } from "../components/tool-labels";
import type { VoiceSnapshot } from "./voice-session";

/**
 * The session lands in the thread (the decided ENG-185 model: the stage is the
 * experience, the thread is the record). Transcript lines and feed entries are
 * interleaved by their session order and folded into ordinary messages: user
 * captions become user turns; agent captions, views, and resolved approvals
 * become assistant turns. Reloading the page replays them like any history.
 */
export function voiceSessionMessages(snapshot: VoiceSnapshot): FlowletUIMessage[] {
  type Part = FlowletUIMessage["parts"][number];
  type Entry = { role: "user" | "assistant"; seq: number; part: Part };
  const entries: Entry[] = [];

  for (const line of snapshot.transcript) {
    if (!line.text.trim()) continue;
    entries.push({
      role: line.role,
      seq: line.seq,
      part: { type: "text", text: line.interrupted ? `${line.text} —` : line.text } as Part,
    });
  }
  for (const entry of snapshot.feed) {
    if (entry.kind === "view") {
      entries.push({ role: "assistant", seq: entry.seq, part: { type: "data-ui", data: entry.node } as Part });
    } else if (entry.kind === "approval" && entry.resolution) {
      // The consent moment is recorded as a compact text trace — replaying a
      // live approval part would re-render an unanswerable pending card.
      const action = toolAction(entry.toolName);
      const trace =
        entry.resolution === "declined"
          ? `${action.request} — declined`
          : `${action.done} — approved ${entry.resolution === "voice" ? "by voice" : "on screen"}`;
      entries.push({ role: "assistant", seq: entry.seq, part: { type: "text", text: trace } as Part });
    }
  }

  entries.sort((a, b) => a.seq - b.seq);

  // Consecutive same-role parts fold into one message so the thread reads as
  // turns, not one bubble per caption.
  const messages: FlowletUIMessage[] = [];
  for (const entry of entries) {
    const last = messages[messages.length - 1];
    if (last && last.role === entry.role) {
      last.parts.push(entry.part);
    } else {
      messages.push({ id: voiceMessageId(), role: entry.role, parts: [entry.part] });
    }
  }
  return messages;
}

let seq = 0;
function voiceMessageId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `voice-${rand}-${++seq}`;
}
