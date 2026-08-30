/**
 * The questions `vendo init --agent` hands back, as data.
 *
 * One personality for init in every mode: it detects, asks, logs in and writes.
 * Agent mode only changes how the questions TRAVEL — init emits them as JSON,
 * the coding agent relays the prompts VERBATIM in chat, the answers come back
 * as flags on a re-run, and that run writes. No new flags exist for any of it:
 * every option below names one of the six init already validates.
 *
 * Only what a PERSON must decide appears here. The zod floor and the theme
 * slots are mechanical, so they default exactly as `--yes` leaves them and show
 * up in the diff instead of in someone's chat.
 *
 * PURE apart from reading the host's dependencies for auth: every prompt is
 * decided from the answers already on the command line, so the whole set is
 * assertable without a run.
 */
import { AUTH_FAMILY_INFO, detectAuthPreset, type AuthPresetName } from "./init-auth.js";
import type { InitOptions } from "./init.js";

/** One answer, carrying the literal thing the agent does to pick it: a flag on
    the re-run, or a command to run before it. No select-vs-confirm machinery —
    yes/no is simply two options. */
export interface InitQuestionOption {
  label: string;
  flag?: string;
  command?: string;
  note?: string;
  recommended?: boolean;
}

export interface InitQuestion {
  id: string;
  /** Chat-ready: agents relay it verbatim. */
  prompt: string;
  options: InitQuestionOption[];
}

export interface InitQuestions {
  status: "questions";
  detected: { framework: string; auth?: AuthPresetName };
  questions: InitQuestion[];
}

const EMBEDDED_OPTION: InitQuestionOption = { label: "Full-Stack Agent: chat + generated screens in your app", flag: "--use-case embedded" };
const AGENT_LOOP_OPTION: InitQuestionOption = { label: "Through your own agent loop (AI SDK / Mastra)", flag: "--use-case agent-loop" };
const MCP_OPTION: InitQuestionOption = { label: "From outside AI apps over MCP", flag: "--use-case mcp" };

/** The first question. Most apps embed — but a host whose own API already runs
    an agent loop has ALREADY decided, and recommending "embedded" to it sent
    people down a path they then had to undo while the route scanner was
    meanwhile excluding that very route from the callable catalog. The
    recommended option comes FIRST and carries its evidence: a recommendation
    whose reason is invisible reads as a guess. */
function useCaseQuestion(agentLoopRoute: string | null): InitQuestion {
  if (agentLoopRoute === null) {
    return {
      id: "use-case",
      prompt: "How will people use your agent? Most apps embed it: your users chat with your product and it builds them real working screens from your data, dashboards, forms, views, right inside your app (recommended). Or: through your own agent loop. Or: from outside AI apps over MCP.",
      options: [{ ...EMBEDDED_OPTION, recommended: true }, AGENT_LOOP_OPTION, MCP_OPTION],
    };
  }
  return {
    id: "use-case",
    prompt: `How will people use your agent? This app already runs an agent loop in ${agentLoopRoute}, so adding Vendo's guarded tools to that loop is the shortest path (recommended) — its route is excluded from the callable catalog either way, so nothing hands the agent a tool that calls itself. Or: embed Vendo's own chat and generated screens in your app. Or: from outside AI apps over MCP.`,
    options: [
      { ...AGENT_LOOP_OPTION, recommended: true, note: `detected an agent loop in ${agentLoopRoute}` },
      EMBEDDED_OPTION,
      MCP_OPTION,
    ],
  };
}

const MODELS: InitQuestion = {
  id: "models",
  prompt: "Vendo needs a model. Easiest is a free Vendo Cloud key, one browser click, no provider account. Set that up? Or use your own Anthropic or OpenAI key.",
  options: [
    { label: "Vendo Cloud, free key", command: "npx vendo login --wait 90", recommended: true },
    { label: "Own key", flag: "--byo", note: "put the key in .env.local first, it never enters the chat" },
  ],
};

/** The dev URL. A QUESTION and not a mechanical default, because the answer is
    WRITTEN (.env.local) and only the person running init knows which origin
    their app answers on — a guessed origin fails the first tool call with the
    developer believing it was configured. The prefill is the port their own
    `dev` script names, so the recommended option is the whole answer. */
const devUrlQuestion = (port: number): InitQuestion => ({
  id: "dev-url",
  prompt: `Where does this app run in dev? Vendo writes it to .env.local as VENDO_BASE_URL: your own agent loop, any backend process and the MCP door all send real HTTP requests back at your API, so without it the first tool call fails. Your dev script says http://localhost:${port}.`,
  options: [
    { label: `http://localhost:${port}`, flag: `--base-url http://localhost:${port}`, recommended: true },
    { label: "Another origin", flag: "--base-url <url>", note: "replace the placeholder with the origin the dev server actually prints" },
  ],
});

/** The MCP arm's ONE question, and the models question's twin: both are
 *  answered by the same Cloud key, so an MCP run asks this instead of `models`
 *  rather than beside it. Init no longer asks WHERE outside agents sign in —
 *  that was a deployment fact nobody has at install time, and a key settles
 *  both environments: the dev machine on its own door, the deployment on the
 *  Cloud broker. */
const MCP_SIGN_IN: InitQuestion = {
  id: "mcp-sign-in",
  prompt: "Vendo Cloud (recommended) or bring your own keys? One free Cloud key runs your models and signs outside agents in — on this machine while you develop, and through Vendo's broker once you deploy, with nothing to copy either way.",
  options: [
    { label: "Vendo Cloud, free key", command: "npx vendo login --wait 90", recommended: true },
    { label: "Own keys", flag: "--byo", note: "put the key in .env.local first, it never enters the chat" },
  ],
};

const PRESETS = Object.keys(AUTH_FAMILY_INFO) as AuthPresetName[];

/** The same seven answers the interactive question offers, in the same order —
    one list, so a relayed question and a typed one cannot disagree. */
const FULL_LIST: InitQuestionOption[] = [
  ...PRESETS.map((preset) => ({ label: AUTH_FAMILY_INFO[preset].name, flag: `--auth ${preset}` })),
  { label: "JWT", flag: "--auth jwt", note: "your API's own signed tokens" },
  { label: "Write my own", flag: "--auth custom", note: "init scaffolds a working seam you replace" },
  { label: "None yet", flag: "--auth none", note: "the agent acts with no signed-in user" },
];

/** The auth question, relayed. Same question and same answers as an
 *  interactive run — the scan only moves the RECOMMENDATION, and only where it
 *  is unambiguous:
 *
 *   · one family detected → that family, with the dependency as its evidence;
 *   · SEVERAL families → no recommendation, deliberately. Two matches is
 *     AMBIGUOUS, and naming one would name a provider the host may not use and
 *     hide the other;
 *   · NOTHING detected → no recommendation either. Init used to recommend "none"
 *     here and then write an anonymous composition nobody chose.
 */
function authQuestion(detection: { wired?: AuthPresetName; dependency?: string; matches: number }): InitQuestion {
  const detected = detection.wired;
  if (detected === undefined) {
    const evidence = detection.matches > 0
      ? "Several auth dependencies are in package.json, so nothing is recommended — naming one would hide the other."
      : "Nothing was detected in package.json, so this one is entirely yours.";
    return { id: "auth", prompt: `How do your users sign in? ${evidence}`, options: FULL_LIST };
  }
  const name = AUTH_FAMILY_INFO[detected].name;
  return {
    id: "auth",
    prompt: `How do your users sign in? package.json says ${name}${detection.dependency === undefined ? "" : ` (${detection.dependency})`}.`,
    options: FULL_LIST.map((option) => (option.flag === `--auth ${detected}`
      ? { ...option, recommended: true, note: `detected ${detection.dependency ?? name}` }
      : option)),
  };
}

/** What is still unanswered on this command line, or null when nothing is —
    which is the signal to go ahead and write. */
export async function initQuestions(input: {
  root: string;
  options: InitOptions;
  framework: string;
  /** A model key is already in hand (env or .env.local), so the models
      question is settled and disappears on the re-run. */
  modelKey: boolean;
  /** A Vendo Cloud key specifically — it settles sign-in for both environments
      at once, so it decides whether the MCP arm's question exists at all. */
  cloudKey: boolean;
  /** The port the host's `dev` script names — the dev-URL question's prefill.
      Passed in rather than read here so the whole set stays assertable. */
  devPort: number;
  /** The host's own agent-loop route (`app/api/chat`), or null — what moves the
      use-case recommendation. Detected by the caller (framework.ts), so this set
      stays assertable without a temp directory. */
  agentLoopRoute?: string | null;
}): Promise<InitQuestions | null> {
  const { options } = input;
  // `wired`, never `matches[0]`: two families matching is AMBIGUOUS, and
  // claiming the first one would name a provider the host may not use and hide
  // the other. Ambiguity falls through to the full-list question.
  const detection = await detectAuthPreset(input.root);
  const detected = detection.wired?.preset;
  const questions: InitQuestion[] = [];
  if (options.useCase === undefined) questions.push(useCaseQuestion(input.agentLoopRoute ?? null));
  if (options.auth === undefined) {
    questions.push(authQuestion({
      ...(detection.wired === null ? {} : { wired: detection.wired.preset, dependency: detection.wired.dependency }),
      matches: detection.matches.length,
    }));
  }
  // A Cloud key answers the model AND how outside agents sign in, so the MCP
  // arm asks its own spelling of the same question IN THE SAME SLOT — two
  // questions with two identical answers is a question asked twice. Both close
  // on the same evidence: a key in .env.local, or `--byo`.
  if (!input.cloudKey && options.byo !== true && options.cloudKey === undefined) {
    if (options.useCase === "mcp") questions.push(MCP_SIGN_IN);
    else if (!input.modelKey) questions.push(MODELS);
  }
  if (options.baseUrl === undefined) questions.push(devUrlQuestion(input.devPort));
  if (questions.length === 0) return null;
  return {
    status: "questions",
    detected: { framework: input.framework, ...(detected === undefined ? {} : { auth: detected }) },
    questions,
  };
}
