import type {
  VoiceDriver,
  VoiceDriverEvent,
  VoiceDriverHandlers,
  VoiceSessionHandle,
} from "../../src/voice/index.js";

export class ScriptedVoiceDriver implements VoiceDriver {
  starts = 0;
  stops = 0;
  muted: boolean[] = [];
  private handlers: VoiceDriverHandlers | null = null;

  start(handlers: VoiceDriverHandlers): VoiceSessionHandle {
    this.starts += 1;
    this.handlers = handlers;
    let stopped = false;
    return {
      setMuted: (muted) => {
        this.muted.push(muted);
      },
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.stops += 1;
      },
    };
  }

  emit(event: VoiceDriverEvent): void {
    this.handlers?.onEvent(event);
  }
}
