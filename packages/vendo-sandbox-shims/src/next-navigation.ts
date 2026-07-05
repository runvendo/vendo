/**
 * Minimal `next/navigation` shim. `useRouter().push/replace` route the host
 * app via vendo.navigate; the rest throw descriptive contained errors rather
 * than silently misbehaving.
 */
import { navigate } from "./dispatch.js";

export function useRouter() {
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href),
    back: () => {
      throw new Error("[vendo] router.back() is not available in a remixed component");
    },
    forward: () => {
      throw new Error("[vendo] router.forward() is not available in a remixed component");
    },
    refresh: () => {
      /* no-op: the host owns refresh */
    },
    prefetch: () => {
      /* no-op */
    },
  };
}

export function usePathname(): string {
  return "";
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams();
}
