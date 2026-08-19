/**
 * The questions `vendo init --agent` hands back, as data.
 *
 * One personality for init in every mode: it detects, asks, logs in and writes.
 * Agent mode only changes how the questions TRAVEL — init emits them as JSON,
 * the coding agent relays the prompts VERBATIM in chat, the answers come back
 * as flags on a re-run, and that run writes. No new flags exist for any of it:
 * every option below names one of the six init already validates.
 *
 * Only what a PERSON must decide appears here. The zod floor, the theme slots
 * and the live check are mechanical, so they default exactly as `--yes` leaves
 * them and show up in the diff instead of in someone's chat.
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

const SERVICE_KEY_PROMPT = "Will your own backend call these tools machine to machine, like a nightly job? If yes I'll set up a service key.";

const POSTURE: InitQuestion = {
  id: "posture",
  prompt: "When an outside agent connects, its user always signs in with your app's own login. Who should run the OAuth plumbing around that? Vendo can host it at yourcompany.mcp.vendo.run so none of it lives on your domain (recommended, uses your new cloud account). Or your app serves it itself, also fine, zero config.",
  options: [
    { label: "Vendo hosts the OAuth plumbing", flag: "--posture broker", recommended: true },
    { label: "Your app serves it itself", flag: "--posture local" },
  ],
};

/** MCP's extras. They are relayed together and answered together — see the
 *  single gate in `initQuestions`.
 *
 *  Without a Cloud key there is no posture QUESTION: a keyless run cannot reach
 *  a broker, so local is simply the default (the same rule the terminal flow
 *  follows — init.ts's posture select only appears with a key in hand). Offering
 *  the broker anyway would write a tenant URL that does not exist and silently
 *  drop the service key with it, so the one remaining question carries the
 *  settled `--posture local` on both of its answers instead. */
function mcpQuestions(cloudKey: boolean): InitQuestion[] {
  if (!cloudKey) {
    return [{
      id: "service-key",
      prompt: SERVICE_KEY_PROMPT,
      options: [
        { label: "Yes", flag: "--posture local --service-key" },
        { label: "No", flag: "--posture local" },
      ],
    }];
  }
  return [
    POSTURE,
    {
      id: "service-key",
      prompt: SERVICE_KEY_PROMPT,
      options: [
        { label: "Yes", flag: "--service-key" },
        { label: "No", note: "send the other answers without --service-key" },
      ],
    },
  ];
}

const PRESETS = Object.keys(AUTH_FAMILY_INFO) as AuthPresetName[];

const FULL_LIST: InitQuestionOption[] = [
  ...PRESETS.map((preset) => ({ label: AUTH_FAMILY_INFO[preset].name, flag: `--auth ${preset}` })),
  { label: "Your own JWT scheme", flag: "--auth jwt" },
  { label: "No signed-in user", flag: "--auth none" },
];

/** Interactive mode DETECTS the provider and only confirms it; the agent form
 *  handed back the full list with no recommendation whenever `wired` was empty,
 *  so a coding agent relaying it had to guess for the person. Same detection,
 *  same answer, all three ways it can come out:
 *
 *   · one family wired → that family is recommended (today's question);
 *   · NOTHING detected → `none` is recommended, and the option says why. That is
 *     exactly what an interactive run settles for: it never asks at all, because
 *     there is nothing to choose from the advisory does not already name;
 *   · SEVERAL families → the full list with no recommendation, deliberately. Two
 *     matches is AMBIGUOUS, and naming one would name a provider the host may not
 *     use and hide the other — the same reason interactive shows its picker.
 */
function authQuestion(detection: { wired?: AuthPresetName; matches: number }): InitQuestion {
  const detected = detection.wired;
  if (detected === undefined) {
    return detection.matches > 0
      ? { id: "auth", prompt: "Which auth should Vendo wire?", options: FULL_LIST }
      : {
          id: "auth",
          prompt: "Which auth should Vendo wire? Nothing was detected in package.json, so unless you name one the assistant acts with no signed-in user.",
          options: [
            { label: "No signed-in user", flag: "--auth none", recommended: true, note: "no auth dependency in package.json" },
            ...FULL_LIST.filter((option) => option.flag !== "--auth none"),
          ],
        };
  }
  const name = AUTH_FAMILY_INFO[detected].name;
  const others = [...PRESETS.filter((preset) => preset !== detected), "jwt"].join("|");
  return {
    id: "auth",
    prompt: `It detected ${name}. Should the assistant act as your signed-in ${name} user?`,
    options: [
      { label: "Yes", flag: `--auth ${detected}`, recommended: true },
      { label: "A different auth", flag: `--auth <${others}>`, note: "replace the placeholder with one of those four names" },
      { label: "No signed-in user", flag: "--auth none" },
    ],
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
  /** A Vendo Cloud key specifically — the only thing a broker posture can run
      on, so it decides whether the MCP sign-in question exists at all. */
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
    questions.push(authQuestion({ ...(detected === undefined ? {} : { wired: detected }), matches: detection.matches.length }));
  }
  if (!input.modelKey && options.byo !== true && options.cloudKey === undefined) questions.push(MODELS);
  if (options.baseUrl === undefined) questions.push(devUrlQuestion(input.devPort));
  // ONE gate for the MCP extras: they travel in the same relay, so `--posture`
  // on the way back is what says they were answered. A bare `--service-key` has
  // no "no" spelling, so gating on it would ask forever.
  if (options.useCase === "mcp" && options.posture === undefined) {
    questions.push(...mcpQuestions(input.cloudKey));
  }
  if (questions.length === 0) return null;
  return {
    status: "questions",
    detected: { framework: input.framework, ...(detected === undefined ? {} : { auth: detected }) },
    questions,
  };
}
