/**
 * Toast — a transient notice in the corner, for something that already
 * happened. Base UI's toast manager owns the part that is easy to get wrong:
 * the auto-dismiss timer pauses while the notice is hovered or focused (WCAG
 * 2.2.1) and resumes with the remainder, and the stack announces politely.
 *
 * The brick's contract is declarative — `open` is the truth and the manager is
 * driven to match it — because a generated screen holds its state in `$state`
 * and has nowhere to keep an imperative handle.
 */
import { densityCssVariables, type VendoTheme } from "@vendoai/apps/contract";
import { Toast as Base } from "@base-ui/react/toast";
import { useEffect, useId, useRef, type ComponentProps, type CSSProperties } from "react";
import { useVendoThemeOrDefault } from "../../context.js";
import { themeCssVariables } from "../../theme.js";
import { ensureKitStyles } from "../kit-css.js";
import { font, resolveTone, t, toneStyle, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";
import { closeStyle } from "./dialog.js";

interface ToastOwnProps extends KitStyled {
  open?: boolean;
  onClose?: () => void;
  message?: string;
  tone?: string;
  duration?: number;
}

/** Plus any Base UI `<Toast.Root>` prop, handed straight to the notice — the
 *  surface `style` dresses too, not the viewport the stack sits in. `toast` is
 *  NOT one of them: the manager raises the notice, so the brick owns it. */
export type ToastProps = ToastOwnProps & KitEngine<ComponentProps<typeof Base.Root>, ToastOwnProps, "toast">;

/**
 * The ONE corner every Toast brick on the page raises its notice into.
 *
 * Each brick used to draw its own `position: fixed` box at the same corner, so a
 * second notice painted exactly ON TOP of the first instead of under it — and
 * there is no CSS that relates two independently positioned `fixed` boxes, so the
 * only way they can stack is to share one. Every brick portals its viewport in
 * here as an in-flow child, and the column does the rest.
 *
 * Created here rather than rendered by a brick, because a React-owned stack would
 * belong to whichever brick drew it: that brick unmounting would take every OTHER
 * brick's notice out of the document with it. `data-vendo-portal` is what keeps a
 * notice clickable while the agent panel is open (`inertBehind` exempts it), the
 * same exemption VendoToasts' own stack claims; `data-vendo-ignore` keeps the
 * agent's own scan out of it.
 */
let stack: HTMLElement | null = null;

function toastStack(density: VendoTheme["density"]): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (stack === null) {
    stack = document.createElement("div");
    stack.dataset.vendoIgnore = "";
    stack.dataset.vendoPortal = "kit-toasts";
    Object.assign(stack.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      display: "flex",
      flexDirection: "column",
      width: "min(360px, calc(100vw - 32px))",
    });
  }
  // The one theme value the stack itself needs, HANDED to it rather than read
  // through a `var()`: it is the one element in the Kit that sits outside every
  // theme boundary, so the variable would resolve to its own hardcoded fallback
  // and the rhythm BETWEEN two bricks would ignore density while the rhythm
  // inside one followed it.
  stack.style.gap = densityCssVariables(density)["--vendo-density-inline-gap"]!;
  if (!stack.isConnected) document.body.append(stack);
  return stack;
}

function Notice({ open = false, onClose, message, tone, duration, style, children, pending, ...engine }: ToastProps & KitRendered) {
  const { add, close, toasts } = Base.useToastManager();
  // One notice per BRICK, so re-raising the same one refreshes it in place rather
  // than stacking a duplicate. The id is what "the same one" MEANS, so it is per
  // brick and not the page-wide constant it used to be: two notices coexist in the
  // shared stack now, and one name for both of them is a collision waiting for the
  // day these bricks share a manager instead of one provider each.
  const id = useId();
  const theme = useVendoThemeOrDefault();
  const raised = useRef(false);
  // Held in a ref, NOT in the effect's deps: `add` with a known id refreshes the
  // auto-dismiss timer, so an inline `onClose` in the deps would restart the
  // countdown on every render and the notice would never leave.
  const closing = useRef(onClose);
  closing.current = onClose;

  useEffect(() => {
    if (open) {
      // Unconditionally, NOT only on the way up: `add` with a known id updates
      // that toast in place and refreshes its timer, which is the whole way a
      // declarative notice re-states itself. Gating this on "not already
      // raised" pinned the FIRST message and the FIRST duration for as long as
      // `open` stayed true — a second, different notice silently showed the
      // first one's text. The deps are what keep the timer honest: `add` and
      // `close` are stable (read off the provider's store), so this runs when
      // the notice actually changes and not once per render.
      raised.current = true;
      add({ id, description: message, timeout: duration ?? 5000, onClose: () => closing.current?.() });
    } else if (raised.current) {
      raised.current = false;
      close(id);
    }
  }, [open, message, duration, add, close, id]);

  // The shared stack is a bare positioned box on <body>, outside every themed
  // ancestor, so the theme boundary rides on the VIEWPORT instead: each brick
  // dresses its own notices, and two bricks under two themes stay honest.
  useEffect(() => { ensureKitStyles(); }, []);
  const host = toastStack(theme.density);
  const paint = toneStyle[resolveTone(tone)];
  return host === null ? null : (
    <Base.Portal container={host}>
      <Base.Viewport
        className="vendo-root"
        data-vendo-motion={theme.motion}
        data-vendo-density={theme.density}
        style={{
          ...themeCssVariables(theme) as CSSProperties,
          display: "flex",
          flexDirection: "column",
          gap: "var(--vendo-density-inline-gap, 7px)",
        }}
      >
        {toasts.map((toast) => (
          <Base.Root
            key={toast.id}
            data-kit="Toast"
            {...given(engine)}
            toast={toast}
            style={{
              ...font,
              display: "flex",
              alignItems: "center",
              gap: "var(--vendo-density-inline-gap, 7px)",
              boxSizing: "border-box",
              border: `${t.borderWidth} solid ${paint.border}`,
              borderRadius: t.radiusMedium,
              color: paint.color,
              background: paint.background,
              boxShadow: t.shadowSmall,
              padding: "var(--vendo-density-card-padding, 16px)",
              ...style,
            }}
          >
            <Base.Description style={{ margin: 0, flex: 1, minWidth: 0 }}>{toast.description}</Base.Description>
            <Base.Close data-kit-close="" aria-label="Close" style={{ ...closeStyle, color: "inherit" }}>
              ✕
            </Base.Close>
          </Base.Root>
        ))}
      </Base.Viewport>
    </Base.Portal>
  );
}

export function Toast(props: ToastProps) {
  return (
    <Base.Provider>
      <Notice {...props} />
    </Base.Provider>
  );
}
