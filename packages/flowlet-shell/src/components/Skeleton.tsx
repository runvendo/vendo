/**
 * Placeholder shown while the agent is composing a view — holds the space (in
 * roughly the shape of a card) so the thread doesn't jump, then the real UI
 * swaps in. Replaces visible tool-call chatter.
 */
import type { CSSProperties } from "react";

const bar = (style: CSSProperties) => <div className="fl-skeleton-bar" style={style} />;

export function Skeleton() {
  return (
    <div className="fl-skeleton" aria-hidden="true">
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 13 }}>
        {bar({ width: 30, height: 30, borderRadius: 9 })}
        <div style={{ flex: 1 }}>
          {bar({ width: "60%", height: 11, marginBottom: 6 })}
          {bar({ width: "38%", height: 9 })}
        </div>
      </div>
      {bar({ width: "100%", height: 84, borderRadius: 11, marginBottom: 11 })}
      {bar({ width: "88%", height: 9, marginBottom: 6 })}
      {bar({ width: "64%", height: 9 })}
    </div>
  );
}
