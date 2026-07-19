/** @vendoai/ui/voice — the voice stage driver + surface. Lane D. */
export {
  type KnownVoiceDriverEvent,
  type VoiceDriver,
  type VoiceDriverError,
  type VoiceDriverEvent,
  type VoiceDriverHandlers,
  type VoiceSessionHandle,
  type VoiceSessionState,
  type VoiceSessionView,
  type VoiceState,
  type VoiceToolBridge,
  type VoiceToolCall,
  type VoiceActSession,
  type VoiceTranscriptEntry,
} from "./driver.js";
export { createVoiceActBridge, type VoiceActBridgeOptions } from "./voice-act.js";
export {
  mapRealtimeServerEvent,
  realtimeVoiceDriver,
  type RealtimeMappedEvent,
  type RealtimeVoiceDriverOptions,
} from "./realtime-driver.js";
export { VendoStage, type VendoStageProps } from "./stage.js";
export { useVoice, type UseVoiceResult } from "./use-voice.js";
