/**
 * @vendoai/sandbox-shims — identical-API stand-ins for framework/data modules
 * that cannot run inside the egress-jailed remix sandbox. `vendo sync` maps
 * the framework import specifiers onto these in the sandbox import map.
 */
export { NAVIGATE_ACTION, navigate, dispatch } from "./dispatch.js";
export { default as Link, useLinkStatus, type LinkProps, type UrlObject } from "./next-link.js";
export { default as Image, type ImageProps } from "./next-image.js";
export {
  useRouter,
  usePathname,
  useSearchParams,
  useParams,
  redirect,
  notFound,
  useSelectedLayoutSegment,
  useSelectedLayoutSegments,
} from "./next-navigation.js";
export {
  default as useSWR,
  useSWRConfig,
  mutate,
  SWRConfig,
  preload,
  type SWRResponse,
  type SWRConfiguration,
} from "./swr.js";
