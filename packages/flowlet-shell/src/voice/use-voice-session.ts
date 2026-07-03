import { useCallback, useEffect, useRef, useState } from "react";
import {
  initialVoiceSnapshot,
  reduceVoice,
  type VoiceDriver,
  type VoiceDriverHandle,
  type VoiceSessionActions,
  type VoiceSnapshot,
} from "./voice-session";

export interface VoiceSession extends VoiceSessionActions {
  /** A driver is wired — the mic affordance may render. */
  supported: boolean;
  /** A session is mounted (including its exit beat while "ended"). */
  active: boolean;
  snapshot: VoiceSnapshot;
  start(): void;
  /** Unmount the stage after the exit beat; returns the final snapshot. */
  close(): VoiceSnapshot;
}

/**
 * Owns one voice session at a time over the `VoiceDriver` seam. Amplitude
 * events arrive at ~11Hz and each would re-render the whole stage; they are
 * committed through rAF coalescing instead of per-event setState.
 */
export function useVoiceSession(driver?: VoiceDriver): VoiceSession {
  const [active, setActive] = useState(false);
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(initialVoiceSnapshot);
  const handle = useRef<VoiceDriverHandle | null>(null);
  const latest = useRef<VoiceSnapshot>(initialVoiceSnapshot);
  const frame = useRef<number | null>(null);

  const commit = useCallback(() => {
    frame.current = null;
    setSnapshot(latest.current);
  }, []);

  const start = useCallback(() => {
    if (!driver || handle.current) return;
    latest.current = initialVoiceSnapshot;
    setSnapshot(initialVoiceSnapshot);
    setActive(true);
    handle.current = driver.start((event) => {
      latest.current = reduceVoice(latest.current, event);
      if (event.type === "amplitude") {
        if (frame.current === null && typeof requestAnimationFrame !== "undefined") {
          frame.current = requestAnimationFrame(commit);
        }
        return;
      }
      if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      setSnapshot(latest.current);
    });
  }, [driver, commit]);

  const close = useCallback((): VoiceSnapshot => {
    handle.current?.stop();
    handle.current = null;
    if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setActive(false);
    return latest.current;
  }, []);

  // Unmount tears the session down hard (timers, streams).
  useEffect(
    () => () => {
      handle.current?.stop();
      handle.current = null;
      if (frame.current !== null && typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(frame.current);
    },
    [],
  );

  return {
    supported: !!driver,
    active,
    snapshot,
    start,
    close,
    mute: useCallback((muted: boolean) => handle.current?.mute(muted), []),
    end: useCallback(() => handle.current?.end(), []),
    approve: useCallback((id: string, via: "voice" | "tap") => handle.current?.approve(id, via), []),
    decline: useCallback((id: string) => handle.current?.decline(id), []),
  };
}
