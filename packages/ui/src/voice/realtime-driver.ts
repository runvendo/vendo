import type {
  VoiceDriver,
  VoiceDriverEvent,
  VoiceSessionHandle,
  VoiceSessionState,
  VoiceTranscriptEntry,
} from "./driver.js";

export interface RealtimeVoiceDriverOptions {
  getSession(): Promise<{ clientSecret: string; model?: string }>;
  callsUrl?: string;
  instructions?: string;
  connectTimeoutMs?: number;
  /** @internal Browser/retry capability seam for deterministic tests. */
  __internal?: {
    browserCapabilities?(): BrowserCapabilities;
    reconnectDelayMs?(attempt: number): number;
  };
}

export type RealtimeMappedEvent =
  | { type: "state"; state: VoiceSessionState }
  | { type: "transcript-delta"; id: string; role: VoiceTranscriptEntry["role"]; delta: string }
  | { type: "transcript-final"; id: string; role: VoiceTranscriptEntry["role"]; text: string }
  | { type: "error"; message: string };

const DEFAULT_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const AMPLITUDE_TICK_MS = 30;

/**
 * Maps provider data-channel payloads without touching browser globals. Keeping
 * this seam pure makes protocol growth deterministic and separately testable.
 */
export function mapRealtimeServerEvent(input: unknown): RealtimeMappedEvent[] {
  if (!isRecord(input) || typeof input.type !== "string") return [];
  const type = input.type;

  if (type === "input_audio_buffer.speech_started" || type === "input_audio_buffer.speech_stopped") {
    return [{ type: "state", state: "listening" }];
  }

  if (type.endsWith("input_audio_transcription.delta")) {
    return [{
      type: "transcript-delta",
      id: `user:${stringValue(input.item_id, "input")}`,
      role: "user",
      delta: stringValue(input.delta),
    }];
  }

  if (type.endsWith("input_audio_transcription.completed")) {
    return [{
      type: "transcript-final",
      id: `user:${stringValue(input.item_id, "input")}`,
      role: "user",
      text: stringValue(input.transcript),
    }];
  }

  if (type.startsWith("response.") && type.endsWith("audio_transcript.delta")) {
    return [
      { type: "state", state: "speaking" },
      {
        type: "transcript-delta",
        id: `assistant:${stringValue(input.response_id ?? input.item_id, "response")}`,
        role: "assistant",
        delta: stringValue(input.delta),
      },
    ];
  }

  if (type.startsWith("response.") && type.endsWith("audio_transcript.done")) {
    return [{
      type: "transcript-final",
      id: `assistant:${stringValue(input.response_id ?? input.item_id, "response")}`,
      role: "assistant",
      text: stringValue(input.transcript),
    }];
  }

  if (type === "response.done") return [{ type: "state", state: "listening" }];

  if (type === "error") {
    const error = isRecord(input.error) ? input.error : undefined;
    return [{ type: "error", message: stringValue(error?.message, "Realtime voice error") }];
  }

  return [];
}

/** OpenAI Realtime over WebRTC, using only an ephemeral browser credential. */
export function realtimeVoiceDriver(options: RealtimeVoiceDriverOptions): VoiceDriver {
  return {
    start(handlers): VoiceSessionHandle {
      let alive = true;
      let peer: RTCPeerConnection | null = null;
      let channel: RTCDataChannel | null = null;
      let microphone: MediaStream | null = null;
      let audio: HTMLAudioElement | null = null;
      let audioContext: AudioContext | null = null;
      let microphoneSource: MediaStreamAudioSourceNode | null = null;
      let microphoneAnalyser: AnalyserNode | null = null;
      let remoteSource: MediaStreamAudioSourceNode | null = null;
      let remoteAnalyser: AnalyserNode | null = null;
      let amplitudeTimer: ReturnType<typeof setTimeout> | null = null;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let connectionVersion = 0;
      let reconnecting = false;
      let reconnectAttempt = 0;
      let muted = false;
      let sessionState: VoiceSessionState = "connecting";
      let browser: BrowserCapabilities;
      const accumulated = new Map<string, string>();

      const emit = (event: VoiceDriverEvent) => {
        if (alive) handlers.onEvent(event);
      };

      const clearConnectTimer = () => {
        if (connectTimer === null) return;
        clearTimeout(connectTimer);
        connectTimer = null;
      };

      const clearAmplitude = () => {
        if (amplitudeTimer !== null) {
          clearTimeout(amplitudeTimer);
          amplitudeTimer = null;
        }
        try {
          microphoneSource?.disconnect();
          microphoneAnalyser?.disconnect();
          remoteSource?.disconnect();
          remoteAnalyser?.disconnect();
        } catch {
          // A browser may disconnect audio nodes when their stream ends.
        }
        microphoneSource = null;
        microphoneAnalyser = null;
        remoteSource = null;
        remoteAnalyser = null;
        try {
          if (audioContext) void audioContext.close().catch(() => undefined);
        } catch {
          // The context may already have been closed by its host document.
        }
        audioContext = null;
      };

      const closeConnection = () => {
        connectionVersion += 1;
        clearConnectTimer();
        clearAmplitude();
        const currentChannel = channel;
        const currentPeer = peer;
        const currentMicrophone = microphone;
        const currentAudio = audio;
        channel = null;
        peer = null;
        microphone = null;
        audio = null;
        try {
          currentChannel?.close();
        } catch {
          // The browser may already have closed the channel.
        }
        try {
          currentPeer?.close();
        } catch {
          // The browser may already have closed the peer.
        }
        try {
          currentMicrophone?.getTracks().forEach((track) => track.stop());
        } catch {
          // A partially initialized stream may already be gone.
        }
        try {
          if (currentAudio) {
            currentAudio.srcObject = null;
            currentAudio.remove();
          }
        } catch {
          // A host may have removed the element during teardown.
        }
      };

      const teardown = () => {
        if (!alive) return;
        alive = false;
        if (reconnectTimer !== null) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        closeConnection();
      };

      const fail = (cause: unknown) => {
        if (!alive) return;
        const message = cause instanceof Error ? cause.message : "Voice session failed";
        emit({ type: "error", error: { message, cause } });
        teardown();
      };

      const setSessionState = (state: VoiceSessionState) => {
        sessionState = state;
        emit({ type: "state", state });
      };

      const emitAmplitude = (level: number) => {
        emit({ type: "amplitude", level: Math.max(0, Math.min(1, level)) });
      };

      const readAmplitude = (analyser: AnalyserNode): number => {
        const samples = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = (sample - 128) / 128;
          sum += centered * centered;
        }
        return Math.sqrt(sum / samples.length);
      };

      const startAmplitude = () => {
        if (amplitudeTimer !== null) return;
        const tick = () => {
          amplitudeTimer = null;
          if (!alive) return;
          const analyser = sessionState === "speaking"
            ? remoteAnalyser
            : sessionState === "listening" && !muted
              ? microphoneAnalyser
              : null;
          emitAmplitude(analyser ? readAmplitude(analyser) : 0);
          amplitudeTimer = setTimeout(tick, AMPLITUDE_TICK_MS);
        };
        amplitudeTimer = setTimeout(tick, AMPLITUDE_TICK_MS);
      };

      const setupMicrophoneAmplitude = (stream: MediaStream) => {
        if (!browser.AudioContext) return;
        try {
          audioContext = new browser.AudioContext();
          if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined);
          microphoneSource = audioContext.createMediaStreamSource(stream);
          microphoneAnalyser = audioContext.createAnalyser();
          microphoneAnalyser.fftSize = 256;
          microphoneSource.connect(microphoneAnalyser);
        } catch {
          clearAmplitude();
        }
      };

      const setupRemoteAmplitude = (stream: MediaStream) => {
        if (!audioContext) return;
        try {
          remoteSource?.disconnect();
          remoteAnalyser?.disconnect();
          remoteSource = audioContext.createMediaStreamSource(stream);
          remoteAnalyser = audioContext.createAnalyser();
          remoteAnalyser.fftSize = 256;
          remoteSource.connect(remoteAnalyser);
        } catch {
          remoteSource = null;
          remoteAnalyser = null;
        }
      };

      const acceptServerEvent = (raw: unknown) => {
        let parsed: unknown = raw;
        if (typeof raw === "string") {
          try {
            parsed = JSON.parse(raw) as unknown;
          } catch {
            return;
          }
        }

        for (const event of mapRealtimeServerEvent(parsed)) {
          if (event.type === "state") {
            setSessionState(event.state);
          } else if (event.type === "transcript-delta") {
            const text = (accumulated.get(event.id) ?? "") + event.delta;
            accumulated.set(event.id, text);
            emit({
              type: "transcript",
              entry: { id: event.id, role: event.role, text, final: false },
            });
          } else if (event.type === "transcript-final") {
            const text = event.text || accumulated.get(event.id) || "";
            accumulated.delete(event.id);
            emit({
              type: "transcript",
              entry: { id: event.id, role: event.role, text, final: true },
            });
          } else {
            fail(new Error(event.message));
          }
        }
      };

      const reconnectDelayMs = (attempt: number) =>
        options.__internal?.reconnectDelayMs?.(attempt) ?? 250 * (2 ** (attempt - 1));

      const reconnectFailure = (cause: unknown) => {
        if (!alive) return;
        closeConnection();
        if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
          fail(new VoiceConnectionError(
            `Voice couldn't reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts: ${causeMessage(cause)}`,
            cause,
          ));
          return;
        }
        scheduleReconnect();
      };

      const connectionLost = (cause: unknown) => {
        if (!alive) return;
        if (reconnecting) {
          reconnectFailure(cause);
          return;
        }
        reconnecting = true;
        reconnectAttempt = 0;
        emitAmplitude(0);
        setSessionState("reconnecting");
        closeConnection();
        scheduleReconnect();
      };

      const armConnectTimeout = (version: number, isReconnect: boolean) => {
        clearConnectTimer();
        connectTimer = setTimeout(() => {
          connectTimer = null;
          if (!alive || connectionVersion !== version) return;
          const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
          const error = new VoiceConnectionError(
            `Voice connection timed out after ${Math.round(timeoutMs / 1_000)} seconds. Please try again.`,
          );
          if (isReconnect) reconnectFailure(error);
          else fail(error);
        }, options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      };

      const dial = async (isReconnect: boolean) => {
        closeConnection();
        const version = connectionVersion;
        armConnectTimeout(version, isReconnect);
        try {
          let stream: MediaStream;
          try {
            stream = await browser.mediaDevices.getUserMedia({ audio: true });
          } catch (cause) {
            throw microphoneError(cause);
          }
          if (!alive || connectionVersion !== version) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          microphone = stream;
          for (const track of stream.getAudioTracks()) track.enabled = !muted;
          setupMicrophoneAmplitude(stream);

          let session: Awaited<ReturnType<RealtimeVoiceDriverOptions["getSession"]>>;
          try {
            session = await options.getSession();
          } catch (cause) {
            throw new VoiceConnectionError(`Voice session setup failed: ${causeMessage(cause)}`, cause);
          }
          if (!session.clientSecret) {
            throw new VoiceConnectionError("Voice session setup failed: no client secret was returned.");
          }
          if (!alive || connectionVersion !== version) return;

          peer = new browser.PeerConnection();
          const currentPeer = peer;
          audio = browser.document.createElement("audio");
          audio.autoplay = true;
          audio.hidden = true;
          browser.document.body.appendChild(audio);

          peer.ontrack = (event) => {
            if (!alive || peer !== currentPeer) return;
            const remote = event.streams[0];
            if (audio && remote) {
              audio.srcObject = remote;
              setupRemoteAmplitude(remote);
              void audio.play().catch((cause: unknown) => {
                if (peer === currentPeer) {
                  connectionLost(new VoiceConnectionError(
                    `Voice audio playback failed: ${causeMessage(cause)}`,
                    cause,
                  ));
                }
              });
            }
          };
          peer.onconnectionstatechange = () => {
            if (!alive || peer !== currentPeer) return;
            if (currentPeer.connectionState === "disconnected" || currentPeer.connectionState === "failed") {
              connectionLost(new VoiceConnectionError(
                currentPeer.connectionState === "disconnected"
                  ? "Voice connection was interrupted."
                  : "Voice connection failed.",
              ));
            }
          };

          for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);

          channel = peer.createDataChannel("oai-events");
          const currentChannel = channel;
          channel.onmessage = (event) => {
            if (channel === currentChannel) acceptServerEvent(event.data);
          };
          channel.onerror = () => {
            if (channel === currentChannel) connectionLost(new VoiceConnectionError("Voice data channel failed."));
          };
          channel.onopen = () => {
            if (!alive || channel !== currentChannel || currentChannel.readyState !== "open") return;
            try {
              if (options.instructions) {
                currentChannel.send(JSON.stringify({
                  type: "session.update",
                  session: { type: "realtime", instructions: options.instructions },
                }));
              }
            } catch (cause) {
              connectionLost(new VoiceConnectionError(`Voice data channel failed: ${causeMessage(cause)}`, cause));
              return;
            }
            clearConnectTimer();
            reconnecting = false;
            reconnectAttempt = 0;
            setSessionState("listening");
            startAmplitude();
          };

          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            if (!offer.sdp) throw new Error("the connection offer was empty");

            const response = await browser.fetch(options.callsUrl ?? DEFAULT_CALLS_URL, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${session.clientSecret}`,
                "Content-Type": "application/sdp",
              },
              body: offer.sdp,
            });
            if (!response.ok) throw new Error(`the server returned HTTP ${response.status}`);
            if (!alive || connectionVersion !== version || peer !== currentPeer) return;
            await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
          } catch (cause) {
            throw new VoiceConnectionError(`Voice SDP exchange failed: ${causeMessage(cause)}`, cause);
          }
        } catch (cause) {
          if (!alive || connectionVersion !== version) return;
          if (isReconnect) reconnectFailure(cause);
          else fail(cause);
        }
      };

      function scheduleReconnect() {
        if (!alive || reconnectTimer !== null) return;
        reconnectAttempt += 1;
        const attempt = reconnectAttempt;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void dial(true);
        }, reconnectDelayMs(attempt));
      }

      setSessionState("connecting");
      try {
        browser = options.__internal?.browserCapabilities?.() ?? browserCapabilities();
        void dial(false);
      } catch (cause) {
        fail(cause);
      }

      return {
        setMuted(nextMuted) {
          if (!alive) return;
          muted = nextMuted;
          microphone?.getAudioTracks().forEach((track) => {
            track.enabled = !nextMuted;
          });
          if (nextMuted && sessionState === "listening") emitAmplitude(0);
        },
        stop: teardown,
      };
    },
  };
}

interface BrowserCapabilities {
  mediaDevices: Pick<MediaDevices, "getUserMedia">;
  PeerConnection: typeof RTCPeerConnection;
  document: Document;
  fetch: typeof fetch;
  AudioContext?: typeof AudioContext;
}

function browserCapabilities(): BrowserCapabilities {
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") {
    throw new Error("Microphone capture is unavailable in this environment");
  }
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("WebRTC is unavailable in this environment");
  }
  if (typeof document === "undefined") {
    throw new Error("Audio playback is unavailable in this environment");
  }
  if (typeof fetch !== "function") {
    throw new Error("SDP exchange is unavailable in this environment");
  }
  // `fetch` must keep `this === window`; called as `browser.fetch(...)` it would
  // throw "Illegal invocation". Bind it so the capability object is safe to call.
  return {
    mediaDevices: navigator.mediaDevices,
    PeerConnection: RTCPeerConnection,
    document,
    fetch: fetch.bind(globalThis),
    AudioContext: typeof AudioContext === "undefined" ? undefined : AudioContext,
  };
}

class VoiceConnectionError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "VoiceConnectionError";
    this.cause = cause;
  }
}

function microphoneError(cause: unknown): VoiceConnectionError {
  if (isRecord(cause) && (cause.name === "NotAllowedError" || cause.name === "SecurityError")) {
    return new VoiceConnectionError(
      "Microphone permission was denied. Allow microphone access and try again.",
      cause,
    );
  }
  return new VoiceConnectionError(`Microphone access failed: ${causeMessage(cause)}`, cause);
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Voice connection failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
