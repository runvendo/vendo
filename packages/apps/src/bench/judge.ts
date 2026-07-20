/**
 * W1-bench (docs/verification/w1-bench) — LLM judge on an independent model
 * (claude-opus-4-8), scoring composition quality 1-5 and flagging fabricated
 * data. The judge never sees which arm produced a wire.
 */
import { generateText } from "ai";
import { judgeModel } from "./client.js";
import { MAPLE_TOOLS } from "./fixtures.js";

export interface Judgement {
  quality: number; // 1-5
  answersAsk: boolean;
  fabricated: boolean;
  notes: string;
  error?: string;
}

const toolList = MAPLE_TOOLS.map((t) => `${t.name} [${t.risk}]`).join(", ");

const RUBRIC = `You are grading a generated UI expressed as "vendo wire" markup — a compact JSX-like tree of prewired/host components bound to host tool data. The ONLY data source is the host tools listed below. Money fields are integer cents; dates are ISO. Charts must take RAW numbers; Stats/Tables/Text shown to users should be formatted.

HOST TOOLS: ${toolList}

Grade the wire for the user request on a 1-5 scale:
5 = fully answers the ask, correct components, all data traces to real tools, formatting correct, actions wired correctly.
4 = answers the ask with a minor issue (one awkward component or one unformatted value).
3 = partially answers; noticeable gaps or a couple of issues.
2 = weak: misses much of the ask or several issues.
1 = does not answer the ask, or is broken/empty.

Also decide:
- answersAsk: does it substantively address the user's request?
- fabricated: does it show business numbers/rows/labels NOT traceable to a host tool (hardcoded/example/placeholder data)? A Disclaimer for an unavailable ask is NOT fabrication.

Respond with ONLY a JSON object: {"quality": <1-5 int>, "answersAsk": <bool>, "fabricated": <bool>, "notes": "<one sentence>"}`;

const parseJudge = (text: string): Judgement | null => {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Partial<Judgement>;
    const quality = Math.max(1, Math.min(5, Math.round(Number(j.quality ?? 0)))) || 1;
    return {
      quality,
      answersAsk: Boolean(j.answersAsk),
      fabricated: Boolean(j.fabricated),
      notes: String(j.notes ?? "").slice(0, 240),
    };
  } catch {
    return null;
  }
};

export const judge = async (prompt: string, wire: string): Promise<Judgement> => {
  if (!wire || wire.length < 8) {
    return { quality: 1, answersAsk: false, fabricated: false, notes: "empty output" };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await generateText({
        model: judgeModel(),
        system: RUBRIC,
        prompt: `USER REQUEST:\n${prompt}\n\nGENERATED WIRE:\n${wire}`,
        maxOutputTokens: 400,
        maxRetries: 0,
      });
      const parsed = parseJudge(res.text);
      if (parsed) return parsed;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/429|overloaded|529|rate|timeout|fetch failed/i.test(msg) && attempt === 2) {
        return { quality: 1, answersAsk: false, fabricated: false, notes: "judge error", error: msg };
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return { quality: 1, answersAsk: false, fabricated: false, notes: "judge unparseable" };
};
