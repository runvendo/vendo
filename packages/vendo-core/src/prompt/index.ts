export {
  genuiFormatSection,
  showVsSaySection,
  refreshableViewsSection,
  connectSection,
  consentSection,
  dataFidelitySection,
  styleSection,
  registerSection,
  capabilitiesSection,
  proactivitySection,
  guardrailSection,
  novelComponentsSection,
  type PromptModality,
} from "./sections.js";
export {
  buildChatInstructions,
  buildVoiceInstructions,
  type ChatInstructionsInput,
  type VoiceInstructionsInput,
} from "./assemblers.js";
export { capabilitySummary, type ToolSummaryInput } from "./capability-summary.js";
export {
  RESOLVE_APPROVAL_TOOL,
  END_SESSION_TOOL,
  voiceConsentProtocol,
  resolveApprovalToolDescription,
  endSessionToolDescription,
  pendingActionNote,
} from "./consent-strings.js";
export { capToolOutput, type CapBudget, type CappedResult } from "./cap-tool-output.js";
export { renderFormatHints } from "./format-hints.js";
