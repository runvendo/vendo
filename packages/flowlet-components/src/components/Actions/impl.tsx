import { useState } from "react";
import { createPrewiredImpl } from "../../impl-helpers/create-impl";
import { actionsSchema } from "./descriptor";
import { z } from "zod";

/** The runtime hands catalog components a per-node dispatch closure as
 *  `props.flowlet`; outside the stage (stub renderer) it is absent and the
 *  buttons render disabled — the affordance degrades, never breaks. */
type Dispatch = { dispatch: (d: { action: string; payload?: unknown }) => Promise<unknown> };
const withFlowlet = actionsSchema.extend({
  flowlet: z.custom<Dispatch>((v) => v == null || typeof (v as Dispatch)?.dispatch === "function").optional(),
});

function ActionButtons(p: z.infer<typeof withFlowlet>) {
  const [pending, setPending] = useState<number | null>(null);
  const canDispatch = typeof p.flowlet?.dispatch === "function";

  const run = async (i: number) => {
    const target = p.actions[i];
    if (!canDispatch || pending !== null || !target) return;
    setPending(i);
    try {
      await p.flowlet!.dispatch({ action: target.action, payload: target.payload });
    } catch {
      // Declines/denials are normal outcomes of the approval flow — the button
      // simply returns to idle; the policy layer owns messaging.
    } finally {
      setPending(null);
    }
  };

  return (
    <div data-actions style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {p.actions.map((a, i) => {
        const variant = a.variant ?? (i === 0 ? "primary" : "secondary");
        const DANGER = "var(--flowlet-danger, #B42318)";
        const styles =
          variant === "primary"
            ? { border: "1px solid transparent", background: "var(--flowlet-accent, #111)", color: "var(--flowlet-surface, #fff)" }
            : variant === "danger"
              ? { border: `1px solid ${DANGER}`, background: "transparent", color: DANGER }
              : { border: "1px solid var(--flowlet-border, rgba(0,0,0,0.15))", background: "transparent", color: "var(--flowlet-fg, inherit)" };
        return (
          <button
            key={`${a.action}-${i}`}
            type="button"
            disabled={!canDispatch || pending !== null}
            onClick={() => run(i)}
            title={canDispatch ? undefined : "Actions are available inside the app"}
            style={{
              font: "inherit", fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.006em",
              padding: "9px 16px", minHeight: 34, cursor: canDispatch ? "pointer" : "default",
              borderRadius: "calc(var(--flowlet-radius, 12px) * 0.6)",
              ...styles,
              opacity: pending === i ? 0.6 : !canDispatch ? 0.5 : 1,
            }}
          >
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

export const Actions = createPrewiredImpl(withFlowlet, (p) => <ActionButtons {...p} />);
