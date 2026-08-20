/**
 * `vendo.tokenFor` — one short-lived, user-bound MCP access token for a
 * backend agent to connect to this deployment's door as that user.
 *
 * ONE function for both postures, because agent code is posture-portable: a
 * Cloud deployment exchanges its provisioned service key at the tenant broker,
 * a BYO one exchanges `mcp.serviceAuth` at the door's own `/token`, and the
 * caller gets the same `vmat_…` back either way. Both legs are the SAME RFC
 * 8693 form POST — the local one rides `vendo.handler`, so it goes through the
 * door's real token endpoint (and its schema latch) without the deployment
 * having to be able to reach itself over the network.
 */
import { joinUrl, VendoError, defaultFetch } from "@vendoai/core";
import type { VendoComposition } from "./compose-context.js";
import { MCP_MOUNT } from "./door-paths.js";

const DOCS = "https://docs.vendo.run/outside-agents/quickstart";

/** A subject that is blank or the literal "undefined" is a user id that was
    stringified before it existed. The exchange would happily mint a valid
    token for a user nobody is, and the mistake would only surface much later,
    as a tool call that finds no data. It dies here instead. */
/** The guard takes `unknown`, so its own error path must survive every value it
    can be handed: JSON.stringify refuses a BigInt outright (snowflake ids and
    postgres int8 both arrive as one), and an object's `toString` is the
    caller's code. Only primitives are invited to render themselves. */
const show = (value: unknown): string =>
  typeof value === "string" ? JSON.stringify(value)
    : value !== null && (typeof value === "object" || typeof value === "function") ? typeof value
      : String(value);

const requireSubject = (subject: unknown): string => {
  if (typeof subject === "string" && subject.trim() !== "" && subject !== "undefined") return subject;
  throw new VendoError(
    "validation",
    `vendo.tokenFor(${show(subject)}) has no user to mint for: a blank, null or "undefined" id means it was `
    + "interpolated before it existed. Pass the id you already have — vendo.tokenFor(user.id) — or pass the "
    + `incoming Request — vendo.tokenFor(request) — to mint for whoever is signed in. ${DOCS}`,
  );
};

/** WHO, off the raw session cookie, through the SAME seam the door itself
    authenticates with — never a hand-read header. */
const sessionSubject = async (
  request: Request,
  oauth: VendoComposition["oauthSeam"],
): Promise<string> => {
  if (oauth?.session === undefined) {
    throw new VendoError(
      "validation",
      "vendo.tokenFor(request) reads the signed-in user through the door's own session seam, and this "
      + "deployment's `oauth` adapter has no `session` (10-mcp §3). Pass the user id instead — "
      + `vendo.tokenFor(user.id) — or compose an \`auth\` preset, which fills the seam. ${DOCS}`,
    );
  }
  const session = await oauth.session(request, { returnTo: request.url });
  if (session instanceof Response) {
    throw new VendoError(
      "forbidden",
      "vendo.tokenFor(request) found no signed-in user on that request: this deployment's auth preset "
      + "resolved no session from it, so there is nobody to mint for. Mint from a request that carries a "
      + `signed-in user's session, or pass the id you already have — vendo.tokenFor(user.id). ${DOCS}`,
    );
  }
  return session.subject;
};

const exchangeForm = (subject: string, serviceKey: string, resource?: string): URLSearchParams =>
  new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    client_id: "vendo-service",
    client_secret: serviceKey,
    subject_token: subject,
    subject_token_type: "urn:vendo:params:oauth:token-type:user-id",
    ...(resource === undefined ? {} : { resource }),
  });

const accessToken = async (response: Response, where: string): Promise<string> => {
  if (!response.ok) {
    throw new VendoError(
      "forbidden",
      `vendo.tokenFor could not exchange a service key at ${where}: it answered ${response.status} `
      + `${(await response.text()).slice(0, 200)}. ${DOCS}`,
    );
  }
  const { access_token: token } = await response.json() as { access_token?: string };
  if (typeof token !== "string") {
    throw new VendoError("unavailable", `vendo.tokenFor got no access_token back from ${where}. ${DOCS}`);
  }
  return token;
};

export function composeTokenFor(
  composition: VendoComposition,
  handler: (request: Request) => Promise<Response>,
): (who: Request | string) => Promise<string> {
  const { mcpOptions, mcpBundle, oauthSeam, configuredBaseUrl } = composition;
  return async (who) => {
    if (mcpOptions === undefined) {
      throw new VendoError(
        "not-implemented",
        "vendo.tokenFor mints a token for THIS deployment's MCP door, and no door is open: compose "
        + `createVendo({ mcp: true }). ${DOCS}`,
      );
    }
    const subject = requireSubject(who instanceof Request ? await sessionSubject(who, oauthSeam) : who);
    if (mcpBundle !== undefined) {
      const { issuer, audience, serviceKey } = await mcpBundle();
      const at = joinUrl(issuer, "/token").href;
      return accessToken(await defaultFetch(at, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: exchangeForm(subject, serviceKey, audience),
      }), at);
    }
    // BYO: the door's own token endpoint, which only exists when the host gave
    // it keys to check the exchange against.
    const serviceKey = mcpOptions.serviceAuth?.keys[0];
    if (serviceKey === undefined) {
      throw new VendoError(
        "validation",
        "vendo.tokenFor exchanges a service key for a user's token, and this door has none: set VENDO_API_KEY "
        + "to let Vendo Cloud provision one, or declare your own — createVendo({ mcp: { serviceAuth: { keys: "
        + `[process.env.VENDO_SERVICE_KEY!] } } }) — which \`vendo init\` generates into .env.local. ${DOCS}`,
      );
    }
    // The token binds to the door's canonical resource URI, which the door
    // derives from the request's own origin — so a token minted against a
    // guessed origin would be refused at the door it was minted for.
    const base = mcpOptions.baseUrl ?? configuredBaseUrl
      ?? (who instanceof Request ? new URL(who.url).origin : undefined);
    if (base === undefined) {
      throw new VendoError(
        "validation",
        "vendo.tokenFor needs this deployment's public URL to bind the token to its MCP door, and none is "
        + `configured: set VENDO_BASE_URL (or createVendo({ mcp: { baseUrl } })). ${DOCS}`,
      );
    }
    // The umbrella dispatches the door at its ORIGIN-ROOT mount (`isDoorPath`),
    // because a path-prefixed deployment strips its own prefix before
    // `vendo.handler` ever sees a request. Only the ORIGIN travels here; the
    // door re-adds the configured prefix itself when it derives the resource
    // URI, so the minted token still binds to the public `…/maple/api/vendo/mcp`
    // a real MCP client connects to. Sending the public spelling would 404
    // before the door was ever reached.
    const at = `${new URL(base).origin}${MCP_MOUNT}/token`;
    return accessToken(await handler(new Request(at, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: exchangeForm(subject, serviceKey),
    })), at);
  };
}
