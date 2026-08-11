/**
 * The `{$handler}` bridge's Kit half — the mark that tells a Kit control its
 * change handler belongs to a LIVE screen rather than to a one-shot host action.
 *
 * The renderer binds `{$handler: "h3"}` to a callback (`tree/renderer.tsx`). A
 * control cannot tell that callback apart from the plain `onChange` a host or a
 * `$action` binding hands it, and the two want opposite behavior: an action
 * handler leaves the DOM owning the text (`defaultValue`, report the value on
 * change), while a screen handler owns the value itself and re-renders it on
 * every keystroke — so that control has to be CONTROLLED or the two disagree
 * about what is in the box. The mark is what makes the difference visible at the
 * control, which is what keeps every pre-screen payload byte-identical.
 *
 * It lives in `kit/` because the renderer already reaches this direction
 * (`kit/state.ts` is the same shape of shared piece) and the reverse edge would
 * be a cycle.
 */

/** A renderer-bound `{$handler}` callback: the event goes to the screen's VM. */
export type HandlerCallback = (event?: unknown) => void;

const MARK = "$vendoHandler";

/** Stamp a bound handler callback. The renderer is the only caller. */
export const markHandlerCallback = (fire: HandlerCallback): HandlerCallback =>
  Object.assign(fire, { [MARK]: true });

/** A renderer-bound screen handler, as opposed to any other `onChange`. */
export const isHandlerCallback = (value: unknown): value is HandlerCallback =>
  typeof value === "function" && (value as unknown as Record<string, unknown>)[MARK] === true;

/**
 * The controlled-mode decision, once, for every text/choice control: a control
 * is controlled only when it has a value to render AND its change handler
 * belongs to a screen. Anything else keeps the uncontrolled DOM it has today.
 */
export const controlledHandler = (hasValue: boolean, onChange: unknown): HandlerCallback | null =>
  hasValue && isHandlerCallback(onChange) ? onChange : null;

/**
 * Only plain data crosses into a screen: the VM is a different realm, so a host
 * object cannot travel and would fail the crossing instead of the handler.
 *
 * Most Kit callbacks already hand over plain data (a string, a boolean, the
 * `{ target }` a controlled control synthesized). `Form`'s `onSubmit` is the
 * exception — it carries the DOM event, whose `target` is a live element — so it
 * is projected down to the two fields a handler ever reads. `preventDefault` is
 * not one of them: `Form` owns that call itself (forms/form.tsx).
 */
export const screenEvent = (event: unknown): unknown => {
  if (event === null || typeof event !== "object") return event;
  if (Array.isArray(event) || Object.getPrototypeOf(event) === Object.prototype) return event;
  const target = (event as { target?: { value?: unknown; checked?: unknown } }).target;
  return target === null || target === undefined
    ? undefined
    : { target: { value: target.value, checked: target.checked } };
};
