export interface ApprovalCardProps {
  toolName: string;
  input: unknown;
  onApprove: () => void;
  onDecline: () => void;
}

export function ApprovalCard({ toolName, input, onApprove, onDecline }: ApprovalCardProps) {
  return (
    <div className="fl-approval" role="group" aria-label={`Approve ${toolName}`}>
      <div style={{ fontFamily: "var(--flowlet-font-mono)", fontSize: 11 }}>approval required · {toolName}</div>
      <pre style={{ fontSize: 11, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{JSON.stringify(input, null, 2)}</pre>
      <div className="fl-approval-actions">
        <button type="button" className="fl-btn fl-btn-primary" onClick={onApprove}>Approve</button>
        <button type="button" className="fl-btn" onClick={onDecline}>Decline</button>
      </div>
    </div>
  );
}
