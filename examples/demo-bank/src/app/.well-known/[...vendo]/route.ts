// 10-mcp §5: the door's four discovery documents live at origin-root paths,
// outside /api/vendo, so the /api/vendo catch-all never sees them — this
// directory exists only to give Next.js a route to dispatch them to. The
// allowlist itself lives in the package (wellKnownVendoHandler), not here, so
// it can't drift from the door's real path set.
//
// No publicVendoRequest wrapping here (contrast the api/vendo route): the
// door already rebases discovery URLs onto VENDO_BASE_URL internally from its
// own configured baseUrl (10-mcp §5, ENG-333) before it ever looks at the
// request's origin, so re-deriving a "public" request here would be redundant.
import { wellKnownVendoHandler } from "@vendoai/vendo/server";
import { vendo } from "@/vendo/server";

export const { GET, POST } = wellKnownVendoHandler(vendo);
