import { toolAction } from "./tool-labels";

export interface FadeProposalCardProps {
  toolName: string;
  onAccept: () => void;
  onDecline: () => void;
}

/**
 * The fade proposal (spec §3 Moment 5): "that's the third time you've
 * okayed this — want me to handle these without checking?" Plain yes/no,
 * quieter register than `ApprovalCard` (this ISN'T another ask, it's an
 * offer to stop asking) — its own dashed "learning" visual identity.
 */
export function FadeProposalCard({ toolName, onAccept, onDecline }: FadeProposalCardProps) {
  const action = toolAction(toolName);
  return (
    <div className="fl-fade" role="group" aria-label="Handle this without asking?">
      <div className="fl-fade-text">
        That's the third time you've okayed {action.request.toLowerCase()} — want me to handle these without checking?
      </div>
      <div className="fl-fade-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onAccept}>Sounds good</button>
        <button type="button" className="fl-btn" onClick={onDecline}>Keep asking</button>
      </div>
    </div>
  );
}
