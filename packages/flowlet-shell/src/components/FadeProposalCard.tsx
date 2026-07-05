import { toolAction } from "./tool-labels";

export interface FadeProposalCardProps {
  toolName: string;
  /** The FadeTracker's own in-window yes-count for this shape at proposal
   *  time (ENG-193 review nit — the card no longer hardcodes "third").
   *  Absent -> a generic fallback renders instead of an ordinal. */
  count?: number;
  onAccept: () => void;
  onDecline: () => void;
}

/** 3 -> "third" (the common case — `threshold` defaults to 3); everything
 *  else gets the standard ordinal suffix ("4th", "5th", ..., "21st", ...). */
function ordinal(count: number): string {
  if (count === 3) return "third";
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${count}th`;
  switch (count % 10) {
    case 1: return `${count}st`;
    case 2: return `${count}nd`;
    case 3: return `${count}rd`;
    default: return `${count}th`;
  }
}

/**
 * The fade proposal (spec §3 Moment 5): "that's the third time you've
 * okayed this — want me to handle these without checking?" Plain yes/no,
 * quieter register than `ApprovalCard` (this ISN'T another ask, it's an
 * offer to stop asking) — its own dashed "learning" visual identity.
 */
export function FadeProposalCard({ toolName, count, onAccept, onDecline }: FadeProposalCardProps) {
  const action = toolAction(toolName);
  const lead =
    count !== undefined
      ? `That's the ${ordinal(count)} time you've okayed ${action.request.toLowerCase()}`
      : "You've okayed this a few times";
  return (
    <div className="fl-fade" role="group" aria-label="Handle this without asking?">
      <div className="fl-fade-text">
        {lead} — want me to handle these without checking?
      </div>
      <div className="fl-fade-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onAccept}>Sounds good</button>
        <button type="button" className="fl-btn" onClick={onDecline}>Keep asking</button>
      </div>
    </div>
  );
}
