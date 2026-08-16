/**
 * TYPE-LEVEL assertions for the overlay props. `tsc` is the entire test: every
 * `@ts-expect-error` below must be USED, and TypeScript reports an unused one
 * as an error of its own — so this file goes red the moment one of these bad
 * calls starts compiling again.
 *
 * Named `.test-d.tsx` on purpose: vitest's `include` matches `*.test.ts?(x)`,
 * so nothing here ever runs as a runtime test.
 *
 * WHY IT EXISTS. The spec (`specs.ts`) requires `onClose` on Modal and Sheet,
 * which governs GENERATED screens. A host developer importing from
 * `@vendoai/ui/kit` writes the props by hand and never passes through it, so
 * `<Modal open />` compiled into a dialog nothing could dismiss. Two doors, one
 * rule; this is the second door.
 */
import { Modal, Sheet, Toast } from "../../src/kit/index.js";

const noop = (): void => {};

// @ts-expect-error `onClose` is required — every way out of a dialog calls it.
export const trappedModal = <Modal open title="No way out" />;

// @ts-expect-error Sheet is the same dialog with a different geometry.
export const trappedSheet = <Sheet open title="No way out" />;

// @ts-expect-error `open` is required too — the spec has said so all along.
export const bareModal = <Modal onClose={noop} title="Never opens" />;

/** Controlled and dismissable is the only shape that compiles. */
export const goodModal = <Modal open onClose={noop} title="Send reminders?" />;
export const goodSheet = <Sheet open onClose={noop} side="left" title="Detail" />;

/** A Toast takes itself down on its own timer, so `onClose` stays OPTIONAL —
 *  it is how the screen learns the notice went, not the way out of it. */
export const bareToast = <Toast open message="Reminders sent." />;
