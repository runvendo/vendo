export { authJsPreset, type AuthJsPresetOptions } from "./auth-js.js";
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
