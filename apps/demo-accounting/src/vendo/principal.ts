import type { Principal } from "@vendoai/vendo";

export const DEMO_USER_ID = "vendo-demo";
export const DEMO_USER_NAME = "Maya Alvarez";

export const DEMO_PRINCIPAL: Principal = {
  kind: "user",
  subject: DEMO_USER_ID,
  display: DEMO_USER_NAME,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function isLocalRequest(req: Request): boolean {
  const host = req.headers.get("host");
  let hostname = host ? (host.split(":")[0] ?? "") : "";
  if (!hostname) {
    try {
      hostname = new URL(req.url).hostname;
    } catch {
      hostname = "";
    }
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export async function resolveDemoPrincipal(req: Request): Promise<Principal | null> {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return DEMO_PRINCIPAL;
  if (process.env.NODE_ENV === "production") return null;
  return isLocalRequest(req) ? DEMO_PRINCIPAL : null;
}
