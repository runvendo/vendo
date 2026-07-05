/**
 * @flowlet/sandbox-shims — identical-API stand-ins for framework/data modules
 * that cannot run inside the egress-jailed remix sandbox. `flowlet sync` maps
 * the framework import specifiers onto these in the sandbox import map.
 */
export { NAVIGATE_ACTION, navigate, dispatch } from "./dispatch";
export { default as Link, type LinkProps } from "./next-link";
export { default as Image, type ImageProps } from "./next-image";
export { useRouter, usePathname, useSearchParams } from "./next-navigation";
export { default as useSWR, type SWRResponse } from "./swr";
