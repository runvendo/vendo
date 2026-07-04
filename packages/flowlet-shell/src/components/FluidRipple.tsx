import type { HTMLAttributes, ReactNode } from "react";
import { Ripple } from "fluidkit";

export interface FluidRippleProps extends HTMLAttributes<HTMLDivElement> {
  color?: string;
  children: ReactNode;
}

/**
 * fluidkit's press ripple, statically imported. fluidkit itself no-ops the
 * ripple under reduced motion (tested degradation contract).
 */
export function FluidRipple({ children, color, ...rest }: FluidRippleProps) {
  return <Ripple color={color} {...rest}>{children}</Ripple>;
}
