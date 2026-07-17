import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

/**
 * Director mode: a chat transport that replays an authored (or recorded)
 * sequence of UI-message chunks at scripted pacing instead of calling the
 * agent. The thread, beats, reveals, approvals, and morphs downstream are the
 * REAL components rendering a real part stream — only the source of the
 * stream is scripted. Demo/capture tooling only; hosts opt in explicitly by
 * passing it through the provider (`VendoProvider transport`), it is never a
 * default.
 *
 * A cue's `chunk` is exactly one SSE `data:` payload of the live wire
 * (`UIMessageChunk`), so a recording of a real build replays verbatim — see
 * the recorder hook in `use-vendo-thread.ts` (`__vendoDirectorRecord`).
 */
export interface DirectorCue {
  /** Milliseconds to wait after the previous cue before emitting this chunk. */
  delay: number;
  chunk: UIMessageChunk;
}

export interface DirectorScript {
  /** Single-turn form. */
  cues?: DirectorCue[];
  /**
   * Multi-turn form: each sendMessages call (initial send, then each
   * approval-driven resume) plays the next turn in order; the last turn
   * repeats if the surface asks again.
   */
  turns?: Array<{ cues: DirectorCue[] }>;
}

export class ScriptedTransport implements ChatTransport<UIMessage> {
  private turnIndex = 0;

  constructor(
    private readonly script: DirectorScript,
    private readonly options: { speed?: number } = {},
  ) {}

  sendMessages(options: { abortSignal: AbortSignal | undefined }): Promise<ReadableStream<UIMessageChunk>> {
    const turns = this.script.turns ?? [{ cues: this.script.cues ?? [] }];
    // Past the last authored turn, close gracefully — REPLAYING a turn would
    // emit tool outputs for calls that live in earlier messages and corrupt
    // the transcript.
    const turn = this.turnIndex < turns.length
      ? turns[this.turnIndex]!
      : {
          cues: [
            { delay: 0, chunk: { type: "start" } as UIMessageChunk },
            { delay: 100, chunk: { type: "text-start", id: "director_end" } as UIMessageChunk },
            { delay: 50, chunk: { type: "text-delta", id: "director_end", delta: "This directed take is finished — reload the page to play it again." } as UIMessageChunk },
            { delay: 50, chunk: { type: "text-end", id: "director_end" } as UIMessageChunk },
            { delay: 50, chunk: { type: "finish" } as UIMessageChunk },
          ],
        };
    this.turnIndex += 1;
    const cues = turn.cues;
    const speed = this.options.speed ?? 1;
    const signal = options.abortSignal;
    return Promise.resolve(
      new ReadableStream<UIMessageChunk>({
        async start(controller) {
          for (const cue of cues) {
            if (signal?.aborted) break;
            if (cue.delay > 0) {
              await new Promise(resolve => setTimeout(resolve, cue.delay / speed));
            }
            if (signal?.aborted) break;
            controller.enqueue(cue.chunk);
            // Staging hook: host surfaces (the dashboard slot) can react to
            // the finished view landing — e.g. swapping the original
            // component in place — without a wire round-trip.
            if (typeof window !== "undefined" && (cue.chunk as { type?: string }).type === "data-vendo-view") {
              const data = (cue.chunk as { data?: { payload?: { streaming?: boolean } } }).data;
              if (data?.payload && data.payload.streaming !== true) {
                window.dispatchEvent(new CustomEvent("vendo-director:view-final", { detail: data }));
              }
            }
          }
          controller.close();
        },
      }),
    );
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}
