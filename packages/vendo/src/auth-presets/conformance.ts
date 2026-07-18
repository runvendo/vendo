import { authMaterialSchema, principalSchema, type AuthMaterial, type PermissionGrant, type Principal } from "@vendoai/core";
import type { ConformanceSuite } from "@vendoai/core/conformance";
import type { HostAuthPreset } from "./shared.js";

/**
 * 09-vendo §2.1 — executable three-seam checks for a HostAuthPreset: the preset
 * must behave exactly like the hand-written per-seam trio it replaces. Built on
 * the core conformance kit's framework-agnostic shape (`@vendoai/core/conformance`),
 * so every named preset (authJs today; clerk/supabase/auth0/jwt as they land)
 * runs the SAME suite: mount with `for (const c of suite.cases) it(c.name, c.run)`
 * or execute via `runConformance`.
 *
 * The suite asserts host-integrated behavior — the preset under test must be
 * configured with a subject→user resolver (or provider-side equivalent) that
 * knows `knownSubject` and has never issued `unknownSubject`.
 */
export interface HostAuthPresetConformanceOptions {
  preset: HostAuthPreset;
  /** Build a wire Request carrying a VALID host session for the subject. */
  sessionRequest(subject: string): Request | Promise<Request>;
  /** A request with no host session. Default: a bare GET with no credentials. */
  anonymousRequest?(): Request;
  /** A subject the host knows: sessions resolve, actAs mints, the door resolves. */
  knownSubject: string;
  /** A subject the host never issued: actAs declines, the door's lookup returns null. */
  unknownSubject: string;
  /** When set, principals resolved for `knownSubject` must carry exactly this display. */
  expectedDisplay?: string;
  /** The grant actAs minting is exercised with. Default: a standing tool grant
      for the subject under test. */
  grant?(subject: string): PermissionGrant;
  /** Out-of-band verification for the actAs round-trip case. Cookie-minting
      presets (authJs, supabase, jwt) mint AuthMaterial their own `principal`
      resolver accepts, so the default round-trips through it — but
      producer/verify-split systems (clerk/auth0, 04 §2.1) mint away-tokens whose
      verifier is host-mounted middleware, not the preset. Supply the split
      system's verify half here; return the verified subject, or null when
      verification rejects the material. */
  verifyActAs?(material: AuthMaterial): Promise<string | null> | string | null;
}

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const defaultAnonymousRequest = (): Request =>
  new Request("https://host.conformance.test/api/vendo/threads");

/** The deployment's public origin, computed exactly the way the presets do:
    the operator-set VENDO_BASE_URL when configured (empty string = unset, the
    umbrella's `environment()` semantics), else the request's own origin. Kept
    env-aware so the redirect case passes on CORRECT preset behavior whether or
    not the suite's runner has VENDO_BASE_URL in its environment. */
const publicOrigin = (request: Request): string => {
  const base = typeof process === "undefined" ? undefined : process.env["VENDO_BASE_URL"];
  if (base !== undefined && base.length > 0) {
    try {
      return new URL(base).origin;
    } catch {
      // An unparseable base is an env misconfiguration; fall back to the
      // request origin rather than failing the case on the harness's env.
    }
  }
  return new URL(request.url).origin;
};

const defaultGrant = (subject: string): PermissionGrant => ({
  id: "grt_host_auth_preset_conformance",
  subject,
  tool: "host_conformance",
  descriptorHash: "sha256:host-auth-preset-conformance",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

const assertKnownPrincipal = (
  resolved: Principal | null,
  opts: HostAuthPresetConformanceOptions,
  seam: string,
): void => {
  assert(resolved !== null, `${seam} returned null for the known subject`);
  const parsed = principalSchema.safeParse(resolved);
  assert(parsed.success, `${seam} returned an invalid Principal`);
  assert(parsed.data.subject === opts.knownSubject, `${seam} resolved the wrong subject: ${parsed.data.subject}`);
  if (opts.expectedDisplay !== undefined) {
    assert(
      parsed.data.display === opts.expectedDisplay,
      `${seam} display was ${String(parsed.data.display)}, expected ${opts.expectedDisplay}`,
    );
  }
};

/** Executable HostAuthPreset checks from 09-vendo §2.1 (plus 01-core §13 for the
    actAs half and 10-mcp §3 for the oauth half). */
export function hostAuthPresetConformance(opts: HostAuthPresetConformanceOptions): ConformanceSuite {
  const anonymousRequest = opts.anonymousRequest ?? defaultAnonymousRequest;
  const grantFor = opts.grant ?? defaultGrant;
  const requireActAs = (): NonNullable<HostAuthPreset["actAs"]> => {
    assert(opts.preset.actAs !== undefined, "preset has no actAs half");
    return opts.preset.actAs;
  };
  const requireOauth = (): NonNullable<HostAuthPreset["oauth"]> => {
    assert(opts.preset.oauth !== undefined, "preset has no oauth half");
    return opts.preset.oauth;
  };
  return {
    seam: "HostAuthPreset",
    cases: [
      {
        name: "09 §2.1 — principal resolves a live session request to the known subject",
        async run(): Promise<void> {
          const resolved = await opts.preset.principal(await opts.sessionRequest(opts.knownSubject));
          assertKnownPrincipal(resolved, opts, "principal");
        },
      },
      {
        name: "09 §2.1 — principal resolves a sessionless request to null (ephemeral anonymous)",
        async run(): Promise<void> {
          assert(
            await opts.preset.principal(anonymousRequest()) === null,
            "principal did not resolve a sessionless request to null",
          );
        },
      },
      {
        name: "01-core §13 — actAs mints AuthMaterial the preset's verification accepts (round-trip)",
        async run(): Promise<void> {
          const material = await requireActAs()(
            { kind: "user", subject: opts.knownSubject },
            grantFor(opts.knownSubject),
          );
          assert(material !== null, "actAs declined the known subject");
          const parsed = authMaterialSchema.safeParse(material);
          assert(parsed.success, "actAs returned invalid AuthMaterial");
          if (opts.verifyActAs !== undefined) {
            // Producer/verify-split systems (clerk/auth0): the mint is real iff
            // the host-mounted verify half accepts it and yields the subject.
            const subject = await opts.verifyActAs(parsed.data);
            assert(subject !== null, "actAs round-trip verification rejected the minted material");
            assert(
              subject === opts.knownSubject,
              `actAs round-trip verified the wrong subject: ${subject}`,
            );
            return;
          }
          // The mint is real iff the preset's own session lookup accepts it —
          // the same round-trip the doctor actAs probe drives over the wire.
          const authed = new Request("https://host.conformance.test/api/vendo/doctor/act-as/echo", {
            headers: parsed.data.headers,
          });
          assertKnownPrincipal(await opts.preset.principal(authed), opts, "actAs round-trip principal");
        },
      },
      {
        name: "01-core §13 — actAs declines a subject the host never issued",
        async run(): Promise<void> {
          const material = await requireActAs()(
            { kind: "user", subject: opts.unknownSubject },
            grantFor(opts.unknownSubject),
          );
          assert(material === null, "actAs minted material for an unknown subject");
        },
      },
      {
        name: "10-mcp §3 — oauth.session returns the subject for a live session",
        async run(): Promise<void> {
          const returnTo = "https://host.conformance.test/api/vendo/mcp/authorize?state=xyz";
          const result = await requireOauth().session?.(
            await opts.sessionRequest(opts.knownSubject),
            { returnTo },
          );
          assert(result !== undefined, "preset oauth half has no session lookup");
          assert(!(result instanceof Response), "oauth.session redirected a live session");
          assert(result.subject === opts.knownSubject, `oauth.session resolved the wrong subject: ${result.subject}`);
        },
      },
      {
        name: "10-mcp §3 — oauth.session redirects a sessionless request to login carrying returnTo",
        async run(): Promise<void> {
          const request = anonymousRequest();
          const returnTo = "https://host.conformance.test/api/vendo/mcp/authorize?state=xyz";
          const result = await requireOauth().session?.(request, { returnTo });
          assert(result !== undefined, "preset oauth half has no session lookup");
          assert(result instanceof Response, "oauth.session did not redirect a sessionless request");
          assert(result.status >= 300 && result.status < 400, `oauth.session returned status ${result.status}, not a redirect`);
          const location = result.headers.get("location");
          assert(location !== null, "oauth.session redirect carries no location");
          const target = new URL(location);
          assert(
            target.origin === publicOrigin(request),
            `oauth.session redirected off the deployment's public origin: ${target.origin}`,
          );
          assert(
            target.searchParams.get("returnTo") === returnTo,
            "oauth.session redirect does not carry the returnTo that resumes authorization",
          );
        },
      },
      {
        name: "10-mcp §3 — oauth.principal resolves the known subject and returns null for an unknown one",
        async run(): Promise<void> {
          const oauth = requireOauth();
          assertKnownPrincipal(await oauth.principal(opts.knownSubject), opts, "oauth.principal");
          assert(
            await oauth.principal(opts.unknownSubject) === null,
            "oauth.principal resolved a subject the host never issued",
          );
        },
      },
    ],
  };
}
