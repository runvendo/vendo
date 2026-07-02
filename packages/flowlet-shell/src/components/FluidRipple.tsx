import { useEffect, useState, type ComponentType, type HTMLAttributes, type ReactNode } from "react";

type RippleComponent = ComponentType<HTMLAttributes<HTMLDivElement> & { color?: string; children: ReactNode }>;

// Same session-cache contract as FluidThinking: undefined = not attempted,
// null = fluidkit unavailable (fallback forever).
let cached: RippleComponent | null | undefined;

export interface FluidRippleProps extends HTMLAttributes<HTMLDivElement> {
  color?: string;
  children: ReactNode;
}

/**
 * fluidkit's press ripple as an enhancement: a plain wrapper until (unless)
 * the library loads. fluidkit itself no-ops the ripple under reduced motion.
 */
export function FluidRipple({ children, color, ...rest }: FluidRippleProps) {
  const [Ripple, setRipple] = useState<RippleComponent | null>(() => cached ?? null);

  useEffect(() => {
    if (cached !== undefined) return;
    let alive = true;
    import("fluidkit").then(
      (mod) => {
        cached = mod.Ripple as RippleComponent;
        if (alive) setRipple(() => mod.Ripple as RippleComponent);
      },
      () => {
        cached = null;
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // `color` is Ripple's prop, not a DOM attribute — keep it off the fallback div.
  if (!Ripple) return <div {...rest}>{children}</div>;
  return <Ripple color={color} {...rest}>{children}</Ripple>;
}
