/**
 * ALL voice consent copy, centralized (context-engineering spec §1). The shell
 * driver keeps its enforcement LOGIC but imports every user- and model-facing
 * phrasing from here, so consent language cannot drift between the prompt core
 * and the driver. Text lifted verbatim from the shipped realtime driver.
 */

export const RESOLVE_APPROVAL_TOOL = "resolve_pending_approval";
export const END_SESSION_TOOL = "end_session";

/** The driver's session-level consent protocol paragraph. */
export function voiceConsentProtocol(hasTools: boolean): string {
  return [
    "You are in a realtime voice session inside the product's own UI.",
    "Speak in short, natural turns. When you show a view, give the headline and point at the screen — never read tables aloud.",
    hasTools
      ? "Some tool calls pause for the user's permission: you will receive a system note naming the pending action. Ask the user aloud, briefly and concretely. If they clearly consent in speech, call " +
        RESOLVE_APPROVAL_TOOL +
        " with approved=true. If they decline or are ambiguous, do not proceed; ask again or move on. Some actions can NEVER be approved by voice — the user must confirm on screen; tell them so."
      : "",
    "When the user indicates they are done (goodbye, that's all), say a brief sign-off and call " +
      END_SESSION_TOOL +
      ".",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Description for the spoken-approval resolver tool. */
export function resolveApprovalToolDescription(): string {
  return "Resolve the pending permission request after the user answered ALOUD. approved=true only for a clear spoken yes.";
}

/** Description for the end-session tool. */
export function endSessionToolDescription(): string {
  return "End the voice session after the user indicates they are done.";
}

/** The system note injected when a tool call pauses for consent. */
export function pendingActionNote(
  toolName: string,
  callId: string,
  tier: "act" | "critical",
): string {
  return tier === "critical"
    ? `Pending action "${toolName}" (id ${callId}) requires ON-SCREEN confirmation. Tell the user briefly to confirm on screen. Do not accept a spoken yes.`
    : `Pending action "${toolName}" (id ${callId}) awaits permission. Ask the user aloud, restating the key facts. On a clear spoken yes call ${RESOLVE_APPROVAL_TOOL}.`;
}
