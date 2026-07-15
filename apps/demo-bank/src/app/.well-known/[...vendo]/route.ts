import { GET as handleVendo } from "../../api/vendo/[...vendo]/route";

const DOOR_PATHS = new Set([
  "/.well-known/oauth-protected-resource/api/vendo/mcp",
  "/.well-known/oauth-authorization-server/api/vendo/mcp",
  "/.well-known/mcp/server-card.json",
  "/.well-known/mcp-server-card",
]);

const forward = (request: Request) =>
  DOOR_PATHS.has(new URL(request.url).pathname)
    ? handleVendo(request)
    : new Response(null, { status: 404 });

export const GET = forward;
export const POST = forward;
