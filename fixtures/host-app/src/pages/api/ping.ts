import type { NextApiRequest, NextApiResponse } from "next";

export default function ping(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.status(405).end();
    return;
  }
  if (!req.headers.cookie?.split(";").some((cookie) => cookie.trim().startsWith("fixture_session="))) {
    res.status(401).json({ error: { code: "unauthenticated", message: "sign in first" } });
    return;
  }

  res.status(200).json({ pong: true });
}
