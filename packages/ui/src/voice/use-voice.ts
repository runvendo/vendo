import { useCallback, useEffect, useRef, useState } from "react";
import { isPlainObject as isRecord } from "@vendoai/core";
import { useVendoContext } from "../context.js";
import type {
  VoiceConnectRequest,
  VoiceDriverEvent,
  VoiceSessionHandle,
  VoiceSessionState,
  VoiceSessionView,
  VoiceState,
  VoiceTranscriptEntry,
} from "./driver.js";

export interface UseVoiceResult {
  state: VoiceState;
  start(): void;
  stop(): void;
  transcript: VoiceTranscriptEntry[];
  error: { message: string } | null;
  muted: boolean;
  setMuted(muted: boolean): void;
  amplitude: number;
  views: VoiceSessionView[];
  /** Latest recognized spoken decision (C-A spoken-yes); consumed via clearIntent. */
  intent: "approve" | "decline" | null;
  clearIntent(): void;
  /** Connector calls blocked on a connection (Cn-A); dismissed by id. */
  connects: VoiceConnectRequest[];
  dismissConnect(id: string): void;
}

const SESSION_STATES = new Set<VoiceSessionState>(["connecting", "reconnecting", "listening", "speaking"]);

/**
 * The frozen headless voice surface (08-ui §3). Without an injected driver,
 * it fails soft as `unavailable` and `start()` is intentionally a no-op.
 */
export function useVoice(): UseVoiceResult {
  const driver = useVendoContext().voice?.driver;
  const [state, setState] = useState<VoiceState>(() => (driver ? "idle" : "unavailable"));
  const [transcript, setTranscript] = useState<VoiceTranscriptEntry[]>([]);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [muted, setMutedState] = useState(false);
  const [amplitude, setAmplitude] = useState(0);
  const [views, setViews] = useState<VoiceSessionView[]>([]);
  const [intent, setIntent] = useState<"approve" | "decline" | null>(null);
  const [connects, setConnects] = useState<VoiceConnectRequest[]>([]);
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
      setError(null);
      setMutedState(false);
      setAmplitude(0);
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
    setError(null);
    setMutedState(false);
    setAmplitude(0);
    setViews([]);
    setIntent(null);
    setConnects([]);
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
    setError(null);
    setMutedState(false);
    setAmplitude(0);
    setViews([]);
    setIntent(null);
    setConnects([]);
    setState("connecting");
    let failedSynchronously = false;

    const onEvent = (event: VoiceDriverEvent) => {
      if (!activeRef.current || generationRef.current !== generation) return;

      if (isStateEvent(event)) {
        if (event.state === "connecting" || event.state === "reconnecting") setAmplitude(0);
        setState(event.state);
        return;
      }

      if (isTranscriptEvent(event)) {
        setTranscript((entries) => updateTranscript(entries, event.entry));
        return;
      }

      if (isAmplitudeEvent(event)) {
        setAmplitude(Math.max(0, Math.min(1, event.level)));
        return;
      }

      if (isViewEvent(event)) {
        setViews((current) => updateViews(current, event.view));
        return;
      }

      if (isIntentEvent(event)) {
        setIntent(event.intent);
        return;
      }

      if (isConnectEvent(event)) {
        setConnects((current) =>
          current.some((c) => c.id === event.connect.id) ? current : [...current, event.connect]);
        return;
      }

      if (event.type === "error") {
        failedSynchronously = handleRef.current === null;
        activeRef.current = false;
        const handle = handleRef.current;
        handleRef.current = null;
        handle?.stop();
        setError({ message: voiceErrorMessage(event) });
        setAmplitude(0);
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
    } catch (cause) {
      activeRef.current = false;
      handleRef.current = null;
      setError({ message: cause instanceof Error ? cause.message : "Voice session failed" });
      setAmplitude(0);
      setState("error");
    }
  }, [driver]);

  const stop = useCallback(() => {
    if (!activeRef.current && !handleRef.current) return;
    stopCurrent();
  }, [stopCurrent]);

  const setMuted = useCallback((nextMuted: boolean) => {
    const handle = handleRef.current;
    if (!activeRef.current || !handle?.setMuted) return;
    handle.setMuted(nextMuted);
    setMutedState(nextMuted);
  }, []);

  const clearIntent = useCallback(() => setIntent(null), []);
  const dismissConnect = useCallback((id: string) => {
    setConnects((current) => current.filter((c) => c.id !== id));
  }, []);

  return { state, start, stop, transcript, error, muted, setMuted, amplitude, views, intent, clearIntent, connects, dismissConnect };
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

function isAmplitudeEvent(event: VoiceDriverEvent): event is { type: "amplitude"; level: number } {
  return event.type === "amplitude" && "level" in event && typeof event.level === "number";
}

function isIntentEvent(event: VoiceDriverEvent): event is { type: "intent"; intent: "approve" | "decline" } {
  return event.type === "intent" && "intent" in event
    && (event.intent === "approve" || event.intent === "decline");
}

function isConnectEvent(event: VoiceDriverEvent): event is { type: "connect"; connect: VoiceConnectRequest } {
  if (event.type !== "connect" || !("connect" in event) || !isRecord(event.connect)) return false;
  return (
    typeof event.connect.id === "string" &&
    typeof event.connect.toolkit === "string" &&
    typeof event.connect.connector === "string" &&
    typeof event.connect.message === "string"
  );
}

function isViewEvent(event: VoiceDriverEvent): event is { type: "view"; view: VoiceSessionView } {
  if (event.type !== "view" || !("view" in event) || !isRecord(event.view)) return false;
  return (
    typeof event.view.id === "string" &&
    typeof event.view.appId === "string" &&
    isRecord(event.view.payload) &&
    typeof event.view.payload.formatVersion === "string"
  );
}

function voiceErrorMessage(event: VoiceDriverEvent): string {
  if (event.type !== "error" || !("error" in event) || !isRecord(event.error)) return "Voice session failed";
  return typeof event.error.message === "string" ? event.error.message : "Voice session failed";
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

function updateViews(current: VoiceSessionView[], incoming: VoiceSessionView): VoiceSessionView[] {
  const index = current.findIndex((view) => view.id === incoming.id);
  if (index < 0) return [...current, incoming];
  const next = [...current];
  next[index] = incoming;
  return next;
}
