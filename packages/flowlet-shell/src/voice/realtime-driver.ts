import type { UINode } from "@flowlet/core";
import type {
  ApprovalTier,
  VoiceDriver,
  VoiceDriverHandle,
  VoiceEvent,
} from "./voice-session";

/**
 * The realtime WebRTC `VoiceDriver` (ENG-185): OpenAI Realtime over a browser
 * peer connection. Audio flows browser ⇄ provider directly (the host backend
 * only mints the ephemeral credential); tool calls arrive on the data channel
 * and execute HERE, in the user's browser, behind the same tier gates as chat
 * (topology B) — the stage's consent bar is the enforcement point, so the
 * voice model cannot bypass approvals no matter what it decides to do.
 */

/** A tool the voice agent may call. Same shape the chat side derives from
 *  `HostToolDefinition`s — pass host tools through `hostToolToVoiceTool`-style
 *  adapters in the app, or hand-author view tools. */
export interface VoiceToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  parameters: Record<string, unknown>;
  tier: ApprovalTier | "read";
  execute(input: unknown): Promise<unknown>;
  /** Optional: project a successful call onto the stage as a view. */
  toView?(input: unknown, output: unknown): UINode | undefined;
}

export interface RealtimeSessionGrant {
  /** Ephemeral client secret minted by the host backend. */
  clientSecret: string;
  /** Model the secret was minted for (informational). */
  model?: string;
}

export interface RealtimeVoiceDriverOptions {
  /** Mint an ephemeral credential from the host backend (never a raw API key). */
  getSession(): Promise<RealtimeSessionGrant>;
  tools?: VoiceToolDef[];
  /** Voice-mode system prompt. The driver appends the consent protocol. */
  instructions?: string;
  /** SDP exchange endpoint. Default: OpenAI's calls endpoint. */
  callsUrl?: string;
  /** Input transcription model (captions). */
  transcriptionModel?: string;
  /** Turn detection config. Default: server VAD with a longer silence window
   *  — stock settings split turns at mid-thought pauses and cancel responses;
   *  semantic VAD stalled without committing in the real-speech E2E. */
  turnDetection?: Record<string, unknown>;
}

const DEFAULT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const AMPLITUDE_TICK_MS = 90;

/** Built-in tools that implement the session protocol itself. */
const RESOLVE_APPROVAL_TOOL = "resolve_pending_approval";
const END_SESSION_TOOL = "end_session";

/** MCP-style annotations → danger tier (mirrors the chat policy layer). */
export function annotationsToTier(annotations: {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}): VoiceToolDef["tier"] {
  if (annotations.readOnlyHint) return "read";
  if (annotations.destructiveHint) return "critical";
  return "act";
}

/** The consent protocol the model is held to — enforcement is client-side
 *  regardless; these instructions just make it BEHAVE well. */
function protocolInstructions(hasTools: boolean): string {
  return [
    "You are in a realtime voice session inside the product's own UI.",
    "Speak in short, natural turns. When you show a view, give the headline and point at the screen — never read tables aloud.",
    hasTools
      ? "Some tool calls pause for the user's permission: you will receive a system note naming the pending action. Ask the user aloud, briefly and concretely. If they clearly consent in speech, call " +
        RESOLVE_APPROVAL_TOOL +
        " with approved=true. If they decline or are ambiguous, do not proceed; ask again or move on. Some actions can NEVER be approved by voice — the user must confirm on screen; tell them so."
      : "",
    "When the user indicates they are done (goodbye, that's all), say a brief sign-off and call " + END_SESSION_TOOL + ".",
  ]
    .filter(Boolean)
    .join(" ");
}

interface PendingApproval {
  def: VoiceToolDef;
  input: unknown;
  callId: string;
}

export function createRealtimeVoiceDriver(options: RealtimeVoiceDriverOptions): VoiceDriver {
  return {
    start(emit): VoiceDriverHandle {
      let alive = true;
      let muted = false;
      let status: string = "connecting";
      let pc: RTCPeerConnection | null = null;
      let dc: RTCDataChannel | null = null;
      let mic: MediaStream | null = null;
      let audioEl: HTMLAudioElement | null = null;
      let audioCtx: AudioContext | null = null;
      let micAnalyser: AnalyserNode | null = null;
      let outAnalyser: AnalyserNode | null = null;
      let amplitudeTimer: ReturnType<typeof setInterval> | null = null;
      let reviveTimer: ReturnType<typeof setTimeout> | null = null;
      const pending = new Map<string, PendingApproval>();
      const handledCalls = new Set<string>();
      // Live caption accumulators (item/response id → text so far).
      const userCaptions = new Map<string, string>();
      const agentCaptions = new Map<string, string>();
      let currentAgentCaption: string | null = null;

      const send = (event: VoiceEvent) => {
        if (!alive) return;
        if (event.type === "status") status = event.status;
        emit(event);
      };

      const sendClient = (payload: Record<string, unknown>) => {
        if (dc && dc.readyState === "open") dc.send(JSON.stringify(payload));
      };

      const tools = options.tools ?? [];
      const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

      const sessionTools = [
        ...tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        {
          type: "function",
          name: RESOLVE_APPROVAL_TOOL,
          description:
            "Resolve the pending permission request after the user answered ALOUD. approved=true only for a clear spoken yes.",
          parameters: {
            type: "object",
            properties: {
              approval_id: { type: "string" },
              approved: { type: "boolean" },
            },
            required: ["approval_id", "approved"],
          },
        },
        {
          type: "function",
          name: END_SESSION_TOOL,
          description: "End the voice session after the user indicates they are done.",
          parameters: { type: "object", properties: {} },
        },
      ];

      const rms = (analyser: AnalyserNode, buf: Uint8Array): number => {
        // Cast: TS 5.9 DOM types pin getByteTimeDomainData to ArrayBuffer-backed views.
        analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          sum += v * v;
        }
        return Math.sqrt(sum / buf.length);
      };

      const startAmplitude = () => {
        const buf = new Uint8Array(256);
        amplitudeTimer = setInterval(() => {
          if (!alive || muted) return;
          const analyser = status === "speaking" ? outAnalyser : status === "listening" ? micAnalyser : null;
          if (!analyser) return;
          // RMS ~0..0.5 for speech; scale into the blob's 0..1 with soft clip.
          send({ type: "amplitude", value: Math.min(1, rms(analyser, buf) * 3.2) });
        }, AMPLITUDE_TICK_MS);
      };

      const finalizeInterruptedCaption = () => {
        if (currentAgentCaption === null) return;
        const text = agentCaptions.get(currentAgentCaption) ?? "";
        if (text) {
          send({ type: "caption", id: `a:${currentAgentCaption}`, role: "assistant", text, final: true, interrupted: true });
        }
        agentCaptions.delete(currentAgentCaption);
        currentAgentCaption = null;
      };

      const completeToolCall = async (callId: string, def: VoiceToolDef, input: unknown) => {
        let output: unknown;
        try {
          output = await def.execute(input);
        } catch (error) {
          output = { error: error instanceof Error ? error.message : "tool failed" };
        }
        if (!alive) return;
        const view = def.toView?.(input, output);
        if (view) send({ type: "view", id: `view:${callId}`, node: view });
        sendClient({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output ?? { ok: true }) },
        });
        sendClient({ type: "response.create" });
      };

      const resolveApproval = (callId: string, approved: boolean, via: "voice" | "tap") => {
        const entry = pending.get(callId);
        if (!entry || !alive) return;
        pending.delete(callId);
        // The gate: a spoken yes NEVER settles a critical action. The model is
        // told this, but the enforcement lives here, not in its manners.
        if (approved && entry.def.tier === "critical" && via === "voice") {
          pending.set(callId, entry);
          sendClient({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "system",
              content: [{ type: "input_text", text: "Verbal approval is not accepted for this action. The user must confirm on screen. Tell them briefly." }],
            },
          });
          sendClient({ type: "response.create" });
          return;
        }
        if (approved) {
          send({ type: "approval-resolved", id: callId, resolution: via });
          void completeToolCall(callId, entry.def, entry.input);
        } else {
          send({ type: "approval-resolved", id: callId, resolution: "declined" });
          sendClient({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ declined: true, note: "The user declined this action." }) },
          });
          sendClient({ type: "response.create" });
        }
      };

      const handleFunctionCall = (name: string, callId: string, argsJson: string) => {
        if (handledCalls.has(callId)) return;
        handledCalls.add(callId);
        let input: unknown = {};
        try {
          input = argsJson ? JSON.parse(argsJson) : {};
        } catch {
          /* malformed args — pass the raw string through */
          input = { raw: argsJson };
        }

        if (name === END_SESSION_TOOL) {
          send({ type: "status", status: "ended" });
          teardown();
          return;
        }
        if (name === RESOLVE_APPROVAL_TOOL) {
          const { approval_id, approved } = (input ?? {}) as { approval_id?: string; approved?: boolean };
          // The model answers the protocol tool itself before we resolve.
          sendClient({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ ok: true }) },
          });
          if (approval_id) resolveApproval(approval_id, approved === true, "voice");
          return;
        }

        const def = toolByName.get(name);
        if (!def) {
          sendClient({
            type: "conversation.item.create",
            item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ error: `unknown tool ${name}` }) },
          });
          sendClient({ type: "response.create" });
          return;
        }
        if (def.tier === "read") {
          void completeToolCall(callId, def, input);
          return;
        }
        // Gated: surface the consent moment and prompt the agent to ask aloud.
        pending.set(callId, { def, input, callId });
        send({ type: "approval", id: callId, toolName: def.name, input, tier: def.tier });
        sendClient({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "system",
            content: [
              {
                type: "input_text",
                text:
                  def.tier === "critical"
                    ? `Pending action "${def.name}" (id ${callId}) requires ON-SCREEN confirmation. Tell the user briefly to confirm on screen. Do not accept a spoken yes.`
                    : `Pending action "${def.name}" (id ${callId}) awaits permission. Ask the user aloud, restating the key facts. On a clear spoken yes call ${RESOLVE_APPROVAL_TOOL}.`,
              },
            ],
          },
        });
        sendClient({ type: "response.create" });
      };

      // ---- server events off the data channel ----
      const onServerEvent = (raw: string) => {
        let evt: { type?: string; [k: string]: unknown };
        try {
          evt = JSON.parse(raw) as { type?: string };
        } catch {
          return;
        }
        const type = evt.type ?? "";

        if (type === "input_audio_buffer.speech_started") {
          // Barge-in: the user talking preempts agent speech instantly.
          finalizeInterruptedCaption();
          if (status !== "ended") send({ type: "status", status: "listening" });
          return;
        }
        // User captions (transcription of the mic input). GA + beta names.
        if (type.endsWith("input_audio_transcription.delta")) {
          const id = String(evt.item_id ?? "u");
          const next = (userCaptions.get(id) ?? "") + String(evt.delta ?? "");
          userCaptions.set(id, next);
          send({ type: "caption", id: `u:${id}`, role: "user", text: next });
          return;
        }
        if (type.endsWith("input_audio_transcription.completed")) {
          const id = String(evt.item_id ?? "u");
          userCaptions.delete(id);
          const text = String(evt.transcript ?? "").trim();
          if (text) send({ type: "caption", id: `u:${id}`, role: "user", text, final: true });
          return;
        }
        // Agent captions (transcript of the audio it speaks). GA + beta names.
        if (type.endsWith("audio_transcript.delta") && type.startsWith("response.")) {
          const id = String(evt.response_id ?? evt.item_id ?? "a");
          currentAgentCaption = id;
          const next = (agentCaptions.get(id) ?? "") + String(evt.delta ?? "");
          agentCaptions.set(id, next);
          if (status !== "speaking" && status !== "ended") send({ type: "status", status: "speaking" });
          send({ type: "caption", id: `a:${id}`, role: "assistant", text: next });
          return;
        }
        if (type.endsWith("audio_transcript.done") && type.startsWith("response.")) {
          const id = String(evt.response_id ?? evt.item_id ?? "a");
          agentCaptions.delete(id);
          if (currentAgentCaption === id) currentAgentCaption = null;
          const text = String(evt.transcript ?? "").trim();
          if (text) send({ type: "caption", id: `a:${id}`, role: "assistant", text, final: true });
          return;
        }
        if (type === "response.created") {
          if (reviveTimer) { clearTimeout(reviveTimer); reviveTimer = null; }
          if (status === "listening") send({ type: "status", status: "thinking" });
          return;
        }
        if (type === "response.function_call_arguments.done") {
          handleFunctionCall(String(evt.name ?? ""), String(evt.call_id ?? ""), String(evt.arguments ?? ""));
          return;
        }
        if (type === "response.done") {
          // Function calls also ride the finished response (belt-and-braces).
          const response = evt.response as
            | { status?: string; output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }> }
            | undefined;
          for (const item of response?.output ?? []) {
            if (item.type === "function_call" && item.call_id) {
              handleFunctionCall(String(item.name ?? ""), item.call_id, String(item.arguments ?? ""));
            }
          }
          if (status === "speaking" || status === "thinking") send({ type: "status", status: "listening" });
          // Dead-air guard (real-speech E2E finding): a turn_detected
          // cancellation with no follow-up turn strands the session — the
          // user asked, nothing ever answers. If no new response starts
          // shortly, revive one (unless we're waiting on a consent).
          if (response?.status === "cancelled" && !reviveTimer) {
            reviveTimer = setTimeout(() => {
              reviveTimer = null;
              if (alive && pending.size === 0 && status !== "ended") {
                sendClient({ type: "response.create" });
              }
            }, 1800);
          }
          return;
        }
        if (type === "error") {
          // Non-fatal server errors are logged; the session usually survives.
          console.error("[flowlet voice] realtime error event", evt);
        }
      };

      const teardown = () => {
        alive = false;
        if (amplitudeTimer) clearInterval(amplitudeTimer);
        try { dc?.close(); } catch { /* already closed */ }
        try { pc?.close(); } catch { /* already closed */ }
        mic?.getTracks().forEach((track) => track.stop());
        void audioCtx?.close().catch(() => undefined);
        if (audioEl) { audioEl.srcObject = null; audioEl.remove(); }
      };

      const init = async () => {
        send({ type: "status", status: "connecting" });
        try {
          const [grant, stream] = await Promise.all([
            options.getSession(),
            navigator.mediaDevices.getUserMedia({ audio: true }),
          ]);
          if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
          mic = stream;

          pc = new RTCPeerConnection();
          audioEl = document.createElement("audio");
          audioEl.autoplay = true;
          document.body.appendChild(audioEl);

          audioCtx = new AudioContext();
          micAnalyser = audioCtx.createAnalyser();
          micAnalyser.fftSize = 256;
          audioCtx.createMediaStreamSource(stream).connect(micAnalyser);

          pc.ontrack = (e) => {
            const remote = e.streams[0];
            if (!remote || !audioEl || !audioCtx) return;
            audioEl.srcObject = remote;
            outAnalyser = audioCtx.createAnalyser();
            outAnalyser.fftSize = 256;
            audioCtx.createMediaStreamSource(remote).connect(outAnalyser);
          };
          pc.onconnectionstatechange = () => {
            if (!alive || !pc) return;
            if (pc.connectionState === "disconnected") {
              send({ type: "status", status: "reconnecting", message: "Voice dropped — reconnecting…" });
            } else if (pc.connectionState === "failed") {
              send({ type: "status", status: "error", message: "Voice couldn't reconnect. Your conversation is saved." });
            } else if (pc.connectionState === "connected" && (status === "reconnecting")) {
              send({ type: "status", status: "listening" });
            }
          };

          const track = stream.getAudioTracks()[0];
          if (track) pc.addTrack(track, stream);

          dc = pc.createDataChannel("oai-events");
          dc.onmessage = (e) => onServerEvent(String(e.data));
          dc.onopen = () => {
            sendClient({
              type: "session.update",
              session: {
                type: "realtime",
                instructions: [options.instructions, protocolInstructions(tools.length > 0)].filter(Boolean).join("\n\n"),
                tools: sessionTools,
                audio: {
                  input: {
                    transcription: { model: options.transcriptionModel ?? "gpt-4o-mini-transcribe" },
                    turn_detection:
                      options.turnDetection ?? {
                        type: "server_vad",
                        silence_duration_ms: 750,
                      },
                  },
                },
              },
            });
            send({ type: "status", status: "listening" });
            startAmplitude();
          };

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const sdpResponse = await fetch(options.callsUrl ?? DEFAULT_CALLS_URL, {
            method: "POST",
            body: offer.sdp,
            headers: {
              Authorization: `Bearer ${grant.clientSecret}`,
              "Content-Type": "application/sdp",
            },
          });
          if (!sdpResponse.ok) throw new Error(`SDP exchange failed (${sdpResponse.status})`);
          const answer = { type: "answer" as const, sdp: await sdpResponse.text() };
          if (!alive || !pc) return;
          await pc.setRemoteDescription(answer);
        } catch (error) {
          if (!alive) return;
          console.error("[flowlet voice] failed to start realtime session", error);
          send({
            type: "status",
            status: "error",
            message: "Voice couldn't start. Check the microphone permission and try again.",
          });
        }
      };

      void init();

      return {
        mute(next) {
          muted = next;
          mic?.getAudioTracks().forEach((track) => { track.enabled = !next; });
          send({ type: "muted", muted: next });
        },
        end() {
          send({ type: "status", status: "ended" });
          teardown();
        },
        approve(id, via) {
          resolveApproval(id, true, via);
        },
        decline(id) {
          resolveApproval(id, false, "tap");
        },
        stop: teardown,
      };
    },
  };
}
