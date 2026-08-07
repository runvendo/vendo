import type { NextApiHandler, NextApiRequest, NextApiResponse } from "next";

export const handler: NextApiHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  if (req.method !== "GET") {
    res.status(405).end();
    return;
  }
  if (!req.headers.cookie?.split(";").some((cookie) => cookie.trim().startsWith("fixture_session="))) {
    res.status(401).json({ error: { code: "unauthenticated", message: "sign in first" } });
    return;
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.status(200).send("id,status\ninv_0001,paid\ninv_0004,paid\ninv_0007,paid\n");
};

export function withReporting(pageHandler: NextApiHandler): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader("X-Fixture-Report", "invoice-export");
    await pageHandler(req, res);
  };
}
