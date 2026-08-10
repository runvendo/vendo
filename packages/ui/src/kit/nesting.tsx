/**
 * Where a node sits (W2 §The Kit). One thing leads on a screen, and it is the
 * OUTERMOST heading: a heading inside a Card or Surface is that section's title,
 * so it renders at section scale instead of headline scale. Structural, because
 * a component cannot ask the model where it put things.
 */
import { createContext, useContext, type ReactNode } from "react";

const InsideContainer = createContext(false);

/** True when the caller renders inside a Card/Surface body. */
export function useInsideContainer(): boolean {
  return useContext(InsideContainer);
}

/** Marks its children as container content. */
export function ContainerBody({ children }: { children: ReactNode }) {
  return <InsideContainer.Provider value={true}>{children}</InsideContainer.Provider>;
}
