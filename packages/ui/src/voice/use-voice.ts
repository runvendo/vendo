import { useCallback, useEffect, useRef, useState } from "react";
import { isPlainObject as isRecord } from "@vendoai/core";
import { useVendoContext } from "../context.js";
import type {
  VoiceDriverEvent,
  VoiceSessionHandle,
  VoiceSessionState,
  VoiceState,
  VoiceTranscriptEntry,
} from "./driver.js";

export interface UseVoiceResult {
  state: VoiceState;
  start(): void;
  stop(): void;
  transcript: VoiceTranscriptEntry[];
}

const SESSION_STATES = new Set<VoiceSessionState>(["connecting", "listening", "speaking"]);

/**
 * The frozen headless voice surface (08-ui §3). Without an injected driver,
 * it fails soft as `unavailable` and `start()` is intentionally a no-op.
 */
export function useVoice(): UseVoiceResult {
  const driver = useVendoContext().voice?.driver;
  const [state, setState] = useState<VoiceState>(() => (driver ? "idle" : "unavailable"));
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const handleRef = useRef<VoiceSessionHandle | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);

  const stopCurrent = useCallback(
    (nextState: VoiceState = driver ? "idle" : "unavailable") => {
      generationRef.current += 1;
      activeRef.current = false;
      const handle = handleRef.current;
      handleRef.current = null;
      handle?.stop();
      setState(nextState);
    },
    [driver],
  );

  useEffect(() => {
    generationRef.current += 1;
    activeRef.current = false;
    handleRef.current?.stop();
    handleRef.current = null;
    setTranscript([]);
    setState(driver ? "idle" : "unavailable");

    return () => {
      generationRef.current += 1;
      activeRef.current = false;
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, [driver]);

  const start = useCallback(() => {
    if (!driver || activeRef.current) return;

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    activeRef.current = true;
    setTranscript([]);
    setState("connecting");
    let failedSynchronously = false;

    const onEvent = (event: VoiceDriverEvent) => {
      if (!activeRef.current || generationRef.current !== generation) return;

      if (isStateEvent(event)) {
        setState(event.state);
        return;
      }

      if (isTranscriptEvent(event)) {
        setTranscript((entries) => updateTranscript(entries, event.entry));
        return;
      }

      if (event.type === "error") {
        failedSynchronously = handleRef.current === null;
        activeRef.current = false;
        const handle = handleRef.current;
        handleRef.current = null;
        handle?.stop();
        setState("error");
      }
      // Unknown variants are ignored for forward compatibility (01-core §15).
    };

    try {
      const handle = driver.start({ onEvent });
      if (failedSynchronously || !activeRef.current || generationRef.current !== generation) {
        handle.stop();
        return;
      }
      handleRef.current = handle;
    } catch {
      activeRef.current = false;
      handleRef.current = null;
      setState("error");
    }
  }, [driver]);

  const stop = useCallback(() => {
    if (!activeRef.current && !handleRef.current) return;
    stopCurrent();
  }, [stopCurrent]);

  return { state, start, stop, transcript };
}

function isStateEvent(
  event: VoiceDriverEvent,
): event is { type: "state"; state: VoiceSessionState } {
  return event.type === "state" && "state" in event && SESSION_STATES.has(event.state as VoiceSessionState);
}

function isTranscriptEvent(
  event: VoiceDriverEvent,
): event is { type: "transcript"; entry: VoiceTranscriptEntry } {
  if (event.type !== "transcript" || !("entry" in event) || !isRecord(event.entry)) return false;
  const entry = event.entry;
  return (
    typeof entry.id === "string" &&
    (entry.role === "user" || entry.role === "assistant") &&
    typeof entry.text === "string" &&
    typeof entry.final === "boolean"
  );
}

function updateTranscript(
  entries: VoiceTranscriptEntry[],
  incoming: VoiceTranscriptEntry,
): VoiceTranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.id === incoming.id);
  if (index < 0) return [...entries, incoming];
  if (entries[index]?.final) return entries;
  const next = [...entries];
  next[index] = incoming;
  return next;
}
