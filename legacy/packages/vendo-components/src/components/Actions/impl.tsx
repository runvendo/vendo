import { useState } from "react";
import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { actionsSchema } from "./descriptor.js";
import { z } from "zod";

/** The runtime hands catalog components a per-node dispatch closure as
 *  `props.vendo`; outside the stage (stub renderer) it is absent and the
 *  buttons render disabled — the affordance degrades, never breaks. */
type Dispatch = { dispatch: (d: { action: string; payload?: unknown }) => Promise<unknown> };
const withVendo = actionsSchema.extend({
  vendo: z.custom<Dispatch>((v) => v == null || typeof (v as Dispatch)?.dispatch === "function").optional(),
});

function ActionButtons(p: z.infer<typeof withVendo>) {
  const [pending, setPending] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const canDispatch = typeof p.vendo?.dispatch === "function";

  const run = async (i: number) => {
    const target = p.actions[i];
    if (!canDispatch || pending !== null || !target) return;
    setPending(i);
    setFailed(null);
    try {
      await p.vendo!.dispatch({ action: target.action, payload: target.payload });
    } catch (e) {
      // A user decline is a normal outcome — return to idle quietly. Anything
      // else (denied by policy, unknown action, server failure) must be
      // SURFACED: the user may have just explicitly approved this action.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/declined|cancelled/i.test(msg)) setFailed(target.label);
    } finally {
      setPending(null);
    }
  };

  return (
    <div data-actions style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      {p.actions.map((a, i) => {
        const variant = a.variant ?? (i === 0 ? "primary" : "secondary");
        const DANGER = "var(--vendo-danger, #B42318)";
        const styles =
          variant === "primary"
            ? { border: "1px solid transparent", background: "var(--vendo-accent, #111)", color: "var(--vendo-surface, #fff)" }
            : variant === "danger"
              ? { border: `1px solid ${DANGER}`, background: "transparent", color: DANGER }
              : { border: "1px solid var(--vendo-border, rgba(0,0,0,0.15))", background: "transparent", color: "var(--vendo-fg, inherit)" };
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
              borderRadius: "calc(var(--vendo-radius, 12px) * 0.6)",
              ...styles,
              opacity: pending === i ? 0.6 : !canDispatch ? 0.5 : 1,
            }}
          >
            {a.label}
          </button>
        );
      })}
      {failed ? (
        <span role="status" style={{ fontSize: 12.5, color: "var(--vendo-danger, #B42318)" }}>
          {failed} could not complete — try again or ask in chat.
        </span>
      ) : null}
    </div>
  );
}

export const Actions = createPrewiredImpl(withVendo, (p) => <ActionButtons {...p} />);
