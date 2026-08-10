/**
 * The in-surface confirmation a mutating action gets BY CONSTRUCTION.
 *
 * The product already grades every tool's risk, and the compiler carries the
 * mutating names into the payload (`Tree.writeTools`), so the renderer knows
 * that a press is about to change or destroy something before it sends the
 * call. It asks here. Nothing about this depends on the screen's author having
 * remembered a dialog: a cancel button that fires on first click is a hazard in
 * a banking surface, and the screen is not the right place to decide that.
 *
 * The dismiss control sits FIRST and the confirm LAST, in the reading order a
 * person expects — and the danger colour is the theme's own, so this is the host's
 * dialog rather than Vendo's.
 */
import type { Json } from "@vendoai/core";
import { humanizeToolName, summarizeArgs } from "../chrome/humanize.js";
import { Button } from "../kit/forms/button.js";
import { font, t } from "../kit/tokens.js";

/** An action the surface has asked about and is holding until the person answers. */
export interface PendingConfirm {
  readonly action: string;
  readonly payload: Json | undefined;
  /** `true` sends the call, `false` drops it. Called exactly once. */
  readonly answer: (send: boolean) => void;
}

export function ConfirmAction({ pending }: { pending: PendingConfirm }) {
  const name = humanizeToolName(pending.action);
  const detail = summarizeArgs(pending.payload);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${name}?`}
      style={{
        position: "fixed",
        inset: 0,
        // Above anything a generated island can stack inside this surface.
        zIndex: 2147483000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: `color-mix(in srgb, ${t.text} 45%, transparent)`,
      }}
    >
      <div
        style={{
          ...font,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          maxWidth: 380,
          width: "100%",
          padding: 20,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusMedium,
          boxShadow: `0 12px 32px color-mix(in srgb, ${t.text} 22%, transparent)`,
        }}
      >
        <strong style={{ fontSize: "1.15em", fontWeight: 650 }}>{`${name}?`}</strong>
        <span style={{ color: t.muted }}>
          {detail === undefined
            ? "This changes your data, and it happens as soon as you confirm."
            : `${detail} — this changes your data, and it happens as soon as you confirm.`}
        </span>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Keep as is" variant="secondary" onClick={() => pending.answer(false)} />
          <Button label={name} variant="danger" onClick={() => pending.answer(true)} />
        </div>
      </div>
    </div>
  );
}
