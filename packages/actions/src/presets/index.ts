// authJsPreset ships on its own subpath ("./presets/auth-js"), not here: it is
// the only preset in this barrel with a top-level optional-peer dynamic
// import (`@auth/core/jwt`), and bundlers resolve every `export ... from`
// target in a barrel file regardless of which named export a consumer
// actually uses — keeping it out of this file means importing ANY of the
// presets below never forces a host to have @auth/core installed
// (corpus-triage Task 9).
export { supabasePreset, type SupabasePresetOptions } from "./supabase.js";
export {
  genericJwtPreset,
  type ClaimsOption,
  type ClaimsResolver,
  type GenericJwtPresetOptions,
  type JwtClaims,
  type SecretSource,
} from "./generic-jwt.js";
// The HS256 verifier the presets mint against, shipped so the umbrella's
// host-identity presets (09-vendo §2.1) resolve sessions with the SAME
// verification the minting halves target — one implementation, both directions.
export { verifyHs256, type VerifyHs256Options } from "./shared.js";
export {
  auth0Preset,
  clerkPreset,
  type AwayTokenClaims,
  type AwayTokenPreset,
  type AwayTokenPresetOptions,
  type AwayTokenProvider,
  type ExpressAwayTokenMiddleware,
  type ExpressAwayTokenRequest,
  type ExpressAwayTokenResponse,
} from "./away-token.js";
