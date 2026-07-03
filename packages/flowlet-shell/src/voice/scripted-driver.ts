import type {
  ApprovalResolution,
  VoiceDriver,
  VoiceDriverHandle,
  VoiceEvent,
} from "./voice-session";

/**
 * A deterministic, timer-driven `VoiceDriver` — the demo/test stand-in for the
 * realtime WebRTC driver. It plays a script of beats in order:
 *
 *   { wait: ms }                          pause
 *   { event: VoiceEvent }                 emit verbatim
 *   { say: {...} }                        stream a caption word by word, then finalize
 *   { waitApproval: id }                  block until that approval resolves
 *   { autoVoiceYes: {...} }               arm a simulated spoken "yes" for a pending
 *                                         approval — cancelled if the user taps first
 *
 * While the status is listening/speaking (and not muted) it synthesizes a
 * gentle amplitude wave so the blob feels alive without a microphone.
 */

export type VoiceScriptBeat =
  | { wait: number }
  | { event: VoiceEvent }
  | {
      say: {
        id: string;
        role: "user" | "assistant";
        text: string;
        /** ms per word while streaming the caption. */
        wordMs?: number;
      };
    }
  | { waitApproval: string }
  | {
      /** Speak a different line depending on how an approval settled.
       *  (Implicitly waits for the resolution, like `waitApproval`.) */
      onResolution: {
        id: string;
        approved?: { id: string; role: "user" | "assistant"; text: string; wordMs?: number };
        declined?: { id: string; role: "user" | "assistant"; text: string; wordMs?: number };
      };
    }
  | {
      autoVoiceYes: {
        /** Approval to resolve as voice-approved. */
        id: string;
        /** How long the "user" thinks before saying yes. */
        after: number;
        /** What they say (streams as a user caption first). */
        sayText: string;
      };
    };

export interface ScriptedVoiceDriverOptions {
  /** Speed multiplier — 0 collapses every wait (tests), 1 is real time. */
  timeScale?: number;
}

const AMPLITUDE_TICK_MS = 90;

export function createScriptedVoiceDriver(
  script: VoiceScriptBeat[],
  options: ScriptedVoiceDriverOptions = {},
): VoiceDriver {
  const scale = options.timeScale ?? 1;

  return {
    start(emit): VoiceDriverHandle {
      let alive = true;
      let muted = false;
      let status = "connecting";
      let phase = 0; // amplitude wave phase
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const resolved = new Map<string, ApprovalResolution>();
      const resolutionWaiters = new Map<string, () => void>();
      const armedAutoYes = new Set<string>();

      const send = (event: VoiceEvent) => {
        if (!alive) return;
        if (event.type === "status") status = event.status;
        emit(event);
      };

      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          if (!alive || ms * scale <= 0) return resolve();
          const t = setTimeout(() => {
            timers.delete(t);
            resolve();
          }, ms * scale);
          timers.add(t);
        });

      // Synthesized liveness: two summed sines read as organic breathing; the
      // real driver replaces this with mic/output levels.
      const amplitudeTimer = setInterval(() => {
        if (!alive) return;
        if (muted || (status !== "listening" && status !== "speaking")) return;
        phase += 1;
        const base = status === "speaking" ? 0.55 : 0.35;
        const wave = Math.sin(phase / 2.1) * 0.25 + Math.sin(phase / 5.7) * 0.2;
        send({ type: "amplitude", value: base + wave });
      }, AMPLITUDE_TICK_MS * Math.max(scale, 0.01));

      const resolveApproval = (id: string, resolution: ApprovalResolution) => {
        if (!alive || resolved.has(id)) return;
        resolved.set(id, resolution);
        send({ type: "approval-resolved", id, resolution });
        resolutionWaiters.get(id)?.();
        resolutionWaiters.delete(id);
      };

      const say = async (beat: Extract<VoiceScriptBeat, { say: unknown }>["say"]) => {
        const words = beat.text.split(" ");
        const wordMs = beat.wordMs ?? 130;
        for (let i = 1; i <= words.length && alive; i++) {
          send({ type: "caption", id: beat.id, role: beat.role, text: words.slice(0, i).join(" ") });
          await sleep(wordMs);
        }
        send({ type: "caption", id: beat.id, role: beat.role, text: beat.text, final: true });
      };

      const run = async () => {
        for (const beat of script) {
          if (!alive) return;
          if ("wait" in beat) {
            await sleep(beat.wait);
          } else if ("event" in beat) {
            send(beat.event);
          } else if ("say" in beat) {
            await say(beat.say);
          } else if ("waitApproval" in beat) {
            if (!resolved.has(beat.waitApproval)) {
              await new Promise<void>((resolve) => {
                if (!alive || resolved.has(beat.waitApproval)) return resolve();
                resolutionWaiters.set(beat.waitApproval, resolve);
              });
            }
          } else if ("onResolution" in beat) {
            const { id, approved, declined } = beat.onResolution;
            if (!resolved.has(id)) {
              await new Promise<void>((resolve) => {
                if (!alive || resolved.has(id)) return resolve();
                resolutionWaiters.set(id, resolve);
              });
            }
            const line = resolved.get(id) === "declined" ? declined : approved;
            if (line && alive) await say(line);
          } else if ("autoVoiceYes" in beat) {
            const { id, after, sayText } = beat.autoVoiceYes;
            armedAutoYes.add(id);
            void sleep(after).then(async () => {
              if (!alive || resolved.has(id) || !armedAutoYes.has(id)) return;
              await say({ id: `${id}:yes`, role: "user", text: sayText, wordMs: 110 });
              resolveApproval(id, "voice");
            });
          }
        }
      };

      void run();

      const teardown = () => {
        alive = false;
        clearInterval(amplitudeTimer);
        for (const t of timers) clearTimeout(t);
        timers.clear();
        for (const wake of resolutionWaiters.values()) wake();
        resolutionWaiters.clear();
      };

      return {
        mute(next) {
          muted = next;
          send({ type: "muted", muted: next });
        },
        end() {
          send({ type: "status", status: "ended" });
          teardown();
        },
        approve(id, via) {
          armedAutoYes.delete(id); // a tap beats the simulated spoken yes
          resolveApproval(id, via);
        },
        decline(id) {
          armedAutoYes.delete(id);
          resolveApproval(id, "declined");
        },
        stop: teardown,
      };
    },
  };
}
