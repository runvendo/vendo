/**
 * The `createVendo` key list `docs-site/reference/handler-options.mdx`
 * publishes — pinned to `CreateVendoConfig` at COMPILE time.
 *
 * The assertions below used to live in `handler-options.docs.test.ts`, where
 * they never ran: `tsconfig.json` excludes `*.test.ts` from the program, so
 * `tsc` never saw them and seven public keys accumulated undocumented while
 * the suite stayed green. Type-level assertions only bite inside a program
 * that is actually typechecked.
 *
 * The `.docs-check.ts` suffix is load-bearing (same as
 * `quickstart-config-surface.docs-check.ts`): `tsconfig.json` excludes it from
 * the build so it never ships as dead declarations, and
 * `tsconfig.docs-check.json` picks it back up for `pnpm typecheck`.
 *
 * The test file still owns the runtime half — that the page's table rows are
 * exactly these names.
 */
import type { CreateVendoConfig } from "./server.js";

/** Every top-level key the composition table documents, in table order. */
export const CONFIG_KEYS = [
  "model",
  "paint",
  "models",
  "auth",
  "principal",
  "catalog",
  "theme",
  "brief",
  "store",
  "sandbox",
  "knowledge",
  "connectors",
  "connectorApps",
  "connections",
  "actAs",
  "serverActions",
  "policy",
  "judge",
  "secrets",
  "telemetry",
  "development",
  "profileDir",
  "fetch",
  "profile",
  "mcp",
  "oauth",
  "agent",
  "sessions",
  "approvals",
  "apps",
  "tours",
] as const;

// Every listed key exists on the interface…
const _listedKeysExist: ReadonlyArray<keyof CreateVendoConfig> = CONFIG_KEYS;
void _listedKeysExist;
// …and every interface key is listed (Exclude resolves to never, or this fails
// naming the undocumented key).
type AssertNever<T extends never> = T;
export type NoMissingKeys = AssertNever<Exclude<keyof CreateVendoConfig, (typeof CONFIG_KEYS)[number]>>;
