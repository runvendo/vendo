import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeName, packsDir } from "../paths";

export const dynamic = "force-dynamic";

interface Pack {
  name: string;
  prompts: string[];
}

/** GET → { packs: Pack[] } from tools/genui-bench/packs/*.json (committed,
 *  shared with agents — unlike runs/, which stays gitignored). */
export async function GET(): Promise<Response> {
  if (!existsSync(packsDir)) return Response.json({ packs: [] });
  const packs: Pack[] = [];
  for (const entry of readdirSync(packsDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      packs.push(JSON.parse(readFileSync(join(packsDir, entry), "utf8")) as Pack);
    } catch {
      // A malformed pack file shouldn't hide the rest.
    }
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return Response.json({ packs });
}

/** POST {pack, prompt} → append the prompt to the pack (creating the pack
 *  file if new). Returns the updated pack. */
export async function POST(request: Request): Promise<Response> {
  let body: { pack?: string; prompt?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response("invalid JSON body", { status: 400 });
  }
  if (typeof body.pack !== "string" || !isSafeName(body.pack)) {
    return new Response("invalid pack name", { status: 400 });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return new Response("prompt is required", { status: 400 });
  }

  mkdirSync(packsDir, { recursive: true });
  const packPath = join(packsDir, `${body.pack}.json`);
  const pack: Pack = existsSync(packPath)
    ? (JSON.parse(readFileSync(packPath, "utf8")) as Pack)
    : { name: body.pack, prompts: [] };
  pack.prompts.push(body.prompt.trim());
  writeFileSync(packPath, JSON.stringify(pack, null, 2) + "\n");
  return Response.json({ pack });
}
