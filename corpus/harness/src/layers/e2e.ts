import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ScorecardCheck, ScorecardLayerInput, ScorecardScore } from "../scorecard.js";

export interface E2eLocator {
  count(): Promise<number>;
  click?(options?: unknown): Promise<void>;
  fill?(value: string): Promise<void>;
  press?(key: string): Promise<void>;
  textContent?(): Promise<string | null>;
  first?(): E2eLocator;
}

export interface E2eFrameLocator {
  locator(selector: string): E2eLocator;
  getByRole(role: string, options?: { name?: string | RegExp }): E2eLocator;
  getByTestId?(testId: string): E2eLocator;
}

export interface E2eRequest {
  url(): string;
  method(): string;
  postData?(): string | null;
  postDataJSON?(): unknown;
}

export interface E2ePage {
  goto(url: string): Promise<void>;
  locator(selector: string): E2eLocator;
  getByRole(role: string, options?: { name?: string | RegExp }): E2eLocator;
  getByLabel(label: string | RegExp): E2eLocator;
  getByTestId?(testId: string): E2eLocator;
  frameLocator?(selector: string): E2eFrameLocator;
  keyboard?: { press(key: string): Promise<void> };
  on?(event: "request", listener: (request: E2eRequest) => void): void;
  off?(event: "request", listener: (request: E2eRequest) => void): void;
  screenshot?(options: { path: string; fullPage?: boolean }): Promise<Buffer | void>;
  close?(): Promise<void>;
}

export interface E2ePageSession {
  page: E2ePage;
  close?: () => Promise<void>;
}

export type E2ePageFactory = (
  script: ConversationScript,
  attemptIndex: number,
) => Promise<E2ePageSession>;

export interface E2eToolSignal {
  name: string;
  method?: string;
  url?: string;
  source?: "host-api" | "action-route" | "voice-tools" | "test";
}

export interface E2eViewSignal {
  component?: string;
  role?: string;
  testId?: string;
  text?: string;
  visible?: boolean;
}

export interface E2eApprovalSignal {
  toolName?: string;
  tier?: string;
  text?: string;
}

export interface E2eErrorSignal {
  text?: string;
}

export interface E2eObservableSignals {
  toolCalls: E2eToolSignal[];
  views: E2eViewSignal[];
  approvals: E2eApprovalSignal[];
  errorToasts: E2eErrorSignal[];
}

export type TextMatcher = string | {
  exact?: string;
  equals?: string;
  contains?: string;
  regex?: string;
};

export type ConversationAssertion =
  | { id?: string; kind: "tool-called"; name: TextMatcher; minimum?: number }
  | {
      id?: string;
      kind: "view-rendered";
      component?: TextMatcher;
      role?: TextMatcher;
      testId?: TextMatcher;
      text?: TextMatcher;
      minimum?: number;
    }
  | { id?: string; kind: "approval-card-shown"; tool?: TextMatcher; minimum?: number }
  | { id?: string; kind: "no-error-toast" };

export interface ConversationScript {
  id: string;
  description?: string;
  prompts: string[];
  assertions: ConversationAssertion[];
  timeoutMs?: number;
  k?: number;
}

export interface ConversationSuite {
  version: 1;
  seedNotes?: string;
  k?: number;
  timeoutMs?: number;
  threshold: number;
  conversations: ConversationScript[];
}

export interface E2eAssertionResult {
  id: string;
  kind: ConversationAssertion["kind"];
  pass: boolean;
  detail: string;
}

export interface E2eAttemptResult {
  attempt: number;
  pass: boolean;
  assertions: E2eAssertionResult[];
  prompts: string[];
  observableText?: string;
  screenshotPath?: string;
  error?: string;
  toolCalls: E2eToolSignal[];
}

export interface E2eConversationResult {
  id: string;
  description?: string;
  k: number;
  successes: number;
  passAtK: boolean;
  attempts: E2eAttemptResult[];
}

export interface E2eLayerContext {
  repoName: string;
  repoDir: string;
  readinessUrl: string;
  expectationsRoot: string;
  logsDir: string;
  pageFactory?: E2ePageFactory;
  now?: () => Date;
}

export interface E2eLayerRunResult {
  layer: ScorecardLayerInput;
}

interface ManifestToolBinding {
  name: string;
  method: string;
  path: string;
  pattern: RegExp;
}

const defaultK = 2;
const defaultTimeoutMs = 60_000;
const pollIntervalMs = 500;
const surfaceOpenRetryMs = 500;
const hardErrorSelector = [
  ".fl-error:visible",
  ".fl-att-error:visible",
  '[data-testid="stage-load-error"]:visible',
  '[data-testid="unexpected-node"]:visible',
  '[data-testid="unimpl-node"]:visible',
  '[data-testid="vendo-invalid-props"]:visible',
  '[data-error="true"]:visible',
].join(", ");
const stageErrorSelector = "[data-error]:visible, [data-error-boundary]:visible";
const errorToastText = /error|failed|unavailable|issue|problem|denied/i;

const matcherObjectSchema = z.object({
  exact: z.string().min(1).optional(),
  equals: z.string().min(1).optional(),
  contains: z.string().min(1).optional(),
  regex: z.string().min(1).optional(),
}).strict().refine(
  (value) => Boolean(value.exact ?? value.equals ?? value.contains ?? value.regex),
  "matcher must define exact, equals, contains, or regex",
);

const textMatcherSchema = z.union([
  z.string().min(1),
  matcherObjectSchema,
]);

const assertionBaseSchema = z.object({
  id: z.string().min(1).optional(),
  minimum: z.number().int().positive().optional(),
});

const rawAssertionSchema = z.union([
  assertionBaseSchema.extend({
    kind: z.literal("tool-called"),
    name: textMatcherSchema,
  }).strict(),
  assertionBaseSchema.extend({
    kind: z.literal("view-rendered"),
    component: textMatcherSchema.optional(),
    role: textMatcherSchema.optional(),
    testId: textMatcherSchema.optional(),
    text: textMatcherSchema.optional(),
  }).strict().refine(
    (value) => Boolean(value.component ?? value.role ?? value.testId ?? value.text),
    "view-rendered must define component, role, testId, or text",
  ),
  assertionBaseSchema.extend({
    kind: z.literal("approval-card-shown"),
    tool: textMatcherSchema.optional(),
  }).strict(),
  z.object({
    id: z.string().min(1).optional(),
    kind: z.literal("no-error-toast"),
  }).strict(),
]);

const assertionSchema = z.preprocess((value) => {
  if (!isRecord(value) || value.kind !== undefined || typeof value.type !== "string") return value;
  const { type: _type, ...rest } = value;
  return { ...rest, kind: value.type };
}, rawAssertionSchema);

const conversationScriptSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  prompts: z.array(z.string().min(1)).min(1),
  assertions: z.array(assertionSchema).min(1),
  timeoutMs: z.number().int().positive().optional(),
  k: z.number().int().positive().optional(),
}).strict();

const conversationSuiteSchema = z.object({
  version: z.literal(1),
  seedNotes: z.string().min(1).optional(),
  k: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1),
  conversations: z.array(conversationScriptSchema).min(1),
}).strict();

// Observation choice for Layer 3: tool calls are observed from network requests
// and mapped back to generated tool names via .vendo/tools.json. UI assertions
// use DOM signals because approval cards, rendered Vendo views, roles, and error
// surfaces are the behavior the user actually sees.
export function parseConversationSuite(value: unknown): ConversationSuite {
  return conversationSuiteSchema.parse(value) as ConversationSuite;
}

export async function loadConversationSuite(
  expectationsRoot: string,
  repoName: string,
): Promise<ConversationSuite | null> {
  const filePath = path.join(expectationsRoot, repoName, "conversations.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseConversationSuite(JSON.parse(raw) as unknown);
}

export function createEmptySignals(): E2eObservableSignals {
  return {
    toolCalls: [],
    views: [],
    approvals: [],
    errorToasts: [],
  };
}

export function textMatches(matcher: TextMatcher, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (typeof matcher === "string") return value.toLowerCase() === matcher.toLowerCase();
  if (matcher.exact !== undefined) return value.toLowerCase() === matcher.exact.toLowerCase();
  if (matcher.equals !== undefined) return value.toLowerCase() === matcher.equals.toLowerCase();
  if (matcher.contains !== undefined) return value.toLowerCase().includes(matcher.contains.toLowerCase());
  if (matcher.regex !== undefined) return new RegExp(matcher.regex, "i").test(value);
  return false;
}

export async function evaluateAssertion(
  assertion: ConversationAssertion,
  signals: E2eObservableSignals,
  page?: E2ePage,
): Promise<E2eAssertionResult> {
  const id = assertion.id ?? assertion.kind;
  if (assertion.kind === "tool-called") {
    const matches = signals.toolCalls.filter((call) => textMatches(assertion.name, call.name));
    const minimum = assertion.minimum ?? 1;
    return {
      id,
      kind: assertion.kind,
      pass: matches.length >= minimum,
      detail: matches.length >= minimum
        ? `${matches.length} matching tool call(s) observed`
        : `expected at least ${minimum} tool call(s); observed ${signals.toolCalls.map((call) => call.name).join(", ") || "none"}`,
    };
  }

  if (assertion.kind === "view-rendered") {
    const signalMatches = signals.views.filter((view) => viewMatches(assertion, view));
    const domMatches = page ? await countViewDomMatches(page, assertion) : 0;
    const count = signalMatches.length + domMatches;
    const minimum = assertion.minimum ?? 1;
    return {
      id,
      kind: assertion.kind,
      pass: count >= minimum,
      detail: count >= minimum
        ? `${count} matching rendered view signal(s) observed`
        : `expected at least ${minimum} rendered view signal(s); observed ${describeViews(signals.views)}`,
    };
  }

  if (assertion.kind === "approval-card-shown") {
    const signalMatches = signals.approvals.filter((approval) =>
      assertion.tool ? textMatches(assertion.tool, approval.toolName) : true,
    );
    const domMatches = page ? await safeCount(page.locator([
      '[aria-label^="Approval request:"]',
      ".fl-approval",
      ".fl-automation-approval",
      '[data-testid="stage-approval"]',
    ].join(", "))) : 0;
    const count = signalMatches.length + domMatches;
    const minimum = assertion.minimum ?? 1;
    return {
      id,
      kind: assertion.kind,
      pass: count >= minimum,
      detail: count >= minimum
        ? `${count} approval card signal(s) observed`
        : `expected at least ${minimum} approval card signal(s)`,
    };
  }

  const signalErrors = signals.errorToasts.length;
  const domErrors = page ? await countErrorDomSignals(page) : 0;
  const count = signalErrors + domErrors;
  return {
    id,
    kind: assertion.kind,
    pass: count === 0,
    detail: count === 0
      ? "no error toast or alert observed"
      : `${count} error toast/alert signal(s) observed`,
  };
}

export async function evaluateAssertions(
  assertions: readonly ConversationAssertion[],
  signals: E2eObservableSignals,
  page?: E2ePage,
): Promise<E2eAssertionResult[]> {
  const results: E2eAssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await evaluateAssertion(assertion, signals, page));
  }
  return results;
}

export function scorePassAtK(
  conversations: readonly E2eConversationResult[],
  threshold: number,
): { score: ScorecardScore; checks: ScorecardCheck[]; passed: boolean } {
  const passed = conversations.filter((conversation) => conversation.passAtK).length;
  const total = conversations.length;
  const value = total === 0 ? 0 : round(passed / total);
  const score = { passed, total, value };
  return {
    score,
    passed: value >= threshold,
    checks: conversations.map((conversation) => ({
      id: `conversation.${conversation.id}`,
      pass: conversation.passAtK,
      detail: conversation.passAtK
        ? `pass@${conversation.k}: ${conversation.successes}/${conversation.k} attempts passed`
        : `pass@${conversation.k}: 0/${conversation.k} attempts passed`,
    })),
  };
}

export async function runE2eLayer(ctx: E2eLayerContext): Promise<E2eLayerRunResult> {
  const suite = await loadConversationSuite(ctx.expectationsRoot, ctx.repoName);
  if (!suite) {
    return {
      layer: {
        layer: 3,
        name: "e2e",
        status: "skip",
        detail: `No conversations.json labels found for ${ctx.repoName}.`,
        hardFailure: false,
      },
    };
  }

  await mkdir(ctx.logsDir, { recursive: true });
  const logPath = path.join(ctx.logsDir, "e2e.conversations.json");
  const screenshots: string[] = [];
  const conversations: E2eConversationResult[] = [];

  for (const script of suite.conversations) {
    conversations.push(await runConversation(ctx, suite, script, screenshots));
  }

  const scored = scorePassAtK(conversations, suite.threshold);
  const generatedAt = (ctx.now ?? (() => new Date()))().toISOString();
  await writeFile(
    logPath,
    JSON.stringify({
      version: 1,
      repo: ctx.repoName,
      generatedAt,
      threshold: suite.threshold,
      defaultK: suite.k ?? defaultK,
      defaultTimeoutMs: suite.timeoutMs ?? defaultTimeoutMs,
      conversations,
    }, null, 2) + "\n",
  );

  return {
    layer: {
      layer: 3,
      name: "e2e",
      status: scored.passed ? "pass" : "fail",
      score: scored.score,
      checks: [
        ...scored.checks,
        {
          id: "e2e.threshold",
          pass: scored.passed,
          detail: `pass@k score ${scored.score.value.toFixed(3)} ${scored.passed ? "met" : "below"} threshold ${suite.threshold.toFixed(3)}`,
        },
      ],
      detail: `Layer 3 pass@k ${scored.score.passed}/${scored.score.total} conversations.`,
      logPaths: [logPath, ...screenshots],
      hardFailure: !scored.passed,
    },
  };
}

async function runConversation(
  ctx: E2eLayerContext,
  suite: ConversationSuite,
  script: ConversationScript,
  screenshots: string[],
): Promise<E2eConversationResult> {
  const k = script.k ?? suite.k ?? defaultK;
  const attempts: E2eAttemptResult[] = [];
  for (let attempt = 1; attempt <= k; attempt += 1) {
    attempts.push(await runAttempt(ctx, suite, script, attempt, screenshots));
  }
  const successes = attempts.filter((attempt) => attempt.pass).length;
  return {
    id: script.id,
    description: script.description,
    k,
    successes,
    passAtK: successes > 0,
    attempts,
  };
}

async function runAttempt(
  ctx: E2eLayerContext,
  suite: ConversationSuite,
  script: ConversationScript,
  attempt: number,
  screenshots: string[],
): Promise<E2eAttemptResult> {
  const signals = createEmptySignals();
  const timeoutMs = script.timeoutMs ?? suite.timeoutMs ?? defaultTimeoutMs;
  let session: E2ePageSession | undefined;
  let recorder: { dispose(): void } | undefined;
  let assertions: E2eAssertionResult[] = [];
  let observableText: string | undefined;
  let error: string | undefined;
  let screenshotPath: string | undefined;

  try {
    session = await (ctx.pageFactory ?? defaultPageFactory)(script, attempt);
    recorder = await attachNetworkSignals(session.page, ctx.repoDir, ctx.readinessUrl, signals);
    const targetUrl = attemptUrl(ctx.readinessUrl, script, attempt);
    await session.page.goto(targetUrl);
    await prepareHostPage(ctx.repoName, session.page, timeoutMs);
    await restoreAttemptUrlAfterHostPrep(ctx.repoName, session.page, targetUrl);
    await openVendoSurface(session.page, timeoutMs);
    for (let index = 0; index < script.prompts.length; index += 1) {
      await sendPrompt(session.page, script.prompts[index] ?? "");
      if (index < script.prompts.length - 1) {
        await waitForIdle(session.page, Math.min(timeoutMs, 30_000));
      }
    }
    assertions = await waitForAssertions(script.assertions, signals, session.page, timeoutMs);
  } catch (caught) {
    error = errorMessage(caught);
  } finally {
    if (session?.page) {
      observableText = await captureObservableText(session.page);
      if (error || assertions.some((assertion) => !assertion.pass)) {
        screenshotPath = path.join(ctx.logsDir, `e2e.${safeFilePart(script.id)}.${attempt}.png`);
        try {
          await session.page.screenshot?.({ path: screenshotPath, fullPage: true });
          screenshots.push(screenshotPath);
        } catch {
          screenshotPath = undefined;
        }
      }
    }
    recorder?.dispose();
    await closeSession(session);
  }

  if (assertions.length === 0) {
    assertions = script.assertions.map((assertion) => ({
      id: assertion.id ?? assertion.kind,
      kind: assertion.kind,
      pass: false,
      detail: error ? `attempt failed before assertion: ${error}` : "assertion was not evaluated",
    }));
  }

  const result: E2eAttemptResult = {
    attempt,
    pass: !error && assertions.every((assertion) => assertion.pass),
    assertions,
    prompts: script.prompts,
    observableText,
    screenshotPath,
    error,
    toolCalls: [...signals.toolCalls],
  };
  if (!result.pass) {
    const diagnosticPath = path.join(ctx.logsDir, `e2e.${safeFilePart(script.id)}.${attempt}.json`);
    await writeFile(diagnosticPath, `${JSON.stringify(result, null, 2)}\n`);
    screenshots.push(diagnosticPath);
  }
  return result;
}

async function defaultPageFactory(): Promise<E2ePageSession> {
  const playwright = await import("@playwright/test");
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page: page as unknown as E2ePage,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

function attemptUrl(baseUrl: string, script: ConversationScript, attempt: number): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("vendoThread", `corpus-${safeFilePart(script.id)}-${attempt}`);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

async function prepareHostPage(repoName: string, page: E2ePage, timeoutMs: number): Promise<void> {
  if (repoName !== "umami") return;
  await loginToUmami(page, Math.min(timeoutMs, 15_000));
}

async function restoreAttemptUrlAfterHostPrep(repoName: string, page: E2ePage, targetUrl: string): Promise<void> {
  if (repoName !== "umami") return;
  await page.goto(targetUrl);
}

async function loginToUmami(page: E2ePage, timeoutMs: number): Promise<void> {
  const username = page.locator('[data-test="input-username"] input, input[name="username"]');
  await waitFor(async () => (await safeCount(username)) > 0, timeoutMs).catch(() => undefined);
  if (await safeCount(username) === 0) return;

  const password = page.locator('[data-test="input-password"] input, input[name="password"]');
  if (!username.fill || !password.fill) return;
  await username.fill("admin");
  await password.fill("umami");
  await clickIfPresent(page.getByRole("button", { name: /^login$/i }));
  await waitFor(async () => (await safeCount(username)) === 0, timeoutMs).catch(() => undefined);
}

async function attachNetworkSignals(
  page: E2ePage,
  repoDir: string,
  baseUrl: string,
  signals: E2eObservableSignals,
): Promise<{ dispose(): void }> {
  const tools = await loadManifestToolBindings(repoDir);
  const onRequest = (request: E2eRequest) => {
    const method = request.method().toUpperCase();
    const url = request.url();
    const pathname = urlPathname(url, baseUrl);
    for (const tool of tools) {
      if (tool.method === method && tool.pattern.test(pathname)) {
        signals.toolCalls.push({ name: tool.name, method, url, source: "host-api" });
      }
    }

    if (pathname.endsWith("/api/vendo/action")) {
      const body = requestJson(request);
      const action = isRecord(body) && typeof body.action === "string" ? body.action : undefined;
      if (action) signals.toolCalls.push({ name: action, method, url, source: "action-route" });
    }

    if (pathname.endsWith("/api/vendo/voice/tools") && method === "POST") {
      const body = requestJson(request);
      const tool = isRecord(body) && typeof body.tool === "string" ? body.tool : undefined;
      if (tool) signals.toolCalls.push({ name: tool, method, url, source: "voice-tools" });
    }
  };
  page.on?.("request", onRequest);
  return {
    dispose() {
      page.off?.("request", onRequest);
    },
  };
}

async function loadManifestToolBindings(repoDir: string): Promise<ManifestToolBinding[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(repoDir, ".vendo/tools.json"), "utf8");
  } catch {
    return [];
  }
  const value = JSON.parse(raw) as unknown;
  const tools = isRecord(value) && Array.isArray(value.tools) ? value.tools : Array.isArray(value) ? value : [];
  return tools.flatMap((tool): ManifestToolBinding[] => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool.binding)) return [];
    const method = typeof tool.binding.method === "string" ? tool.binding.method.toUpperCase() : "";
    const bindingPath = typeof tool.binding.path === "string" ? tool.binding.path : "";
    if (!method || !bindingPath) return [];
    return [{
      name: tool.name,
      method,
      path: bindingPath,
      pattern: compilePathPattern(bindingPath),
    }];
  });
}

async function openVendoSurface(page: E2ePage, timeoutMs: number): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (await safeCount(dialog) > 0) return;

  let lastOpenAttempt = 0;
  await waitFor(async () => {
    if (await safeCount(dialog) > 0) return true;

    const now = Date.now();
    if (now - lastOpenAttempt >= surfaceOpenRetryMs) {
      lastOpenAttempt = now;
      const launcher = page.getByRole("button", { name: /ask|assistant|vendo/i });
      if (!await clickIfPresent(launcher)) {
        await page.keyboard?.press("Meta+K");
        await page.keyboard?.press("Control+K");
      }
    }

    return false;
  }, timeoutMs);
}

async function sendPrompt(page: E2ePage, prompt: string): Promise<void> {
  const input = page.getByLabel(/message/i);
  if (!input.fill) throw new Error("Vendo composer message field did not expose fill()");
  await input.fill(prompt);
  if (input.press) {
    await input.press("Enter");
    return;
  }
  if (!page.keyboard) throw new Error("Vendo composer message field did not expose press() and page has no keyboard");
  await page.keyboard.press("Enter");
}

async function waitForAssertions(
  assertions: readonly ConversationAssertion[],
  signals: E2eObservableSignals,
  page: E2ePage,
  timeoutMs: number,
): Promise<E2eAssertionResult[]> {
  let latest = await evaluateAssertions(assertions, signals, page);
  await waitFor(async () => {
    latest = await evaluateAssertions(assertions, signals, page);
    return latest.every((result) => result.pass);
  }, timeoutMs).catch(() => undefined);
  return latest;
}

async function waitForIdle(page: E2ePage, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const busy = await safeCount(page.locator('[aria-label="Working"], .fl-thinking, .fl-act-pulse'));
    return busy === 0;
  }, timeoutMs).catch(() => undefined);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started <= timeoutMs) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms.${suffix}`);
}

async function countViewDomMatches(page: E2ePage, assertion: Extract<ConversationAssertion, { kind: "view-rendered" }>): Promise<number> {
  let count = 0;
  if (assertion.testId) {
    const literal = literalMatcherValue(assertion.testId);
    if (literal) count += await safeCount(page.getByTestId ? page.getByTestId(literal) : page.locator(attrSelector("data-testid", literal)));
  }
  if (assertion.component) {
    const literal = literalMatcherValue(assertion.component);
    if (literal) count += await safeCount(page.locator(componentSelector(literal)));
  }
  if (assertion.role) {
    const literal = literalMatcherValue(assertion.role);
    if (literal) {
      count += await safeCount(page.getByRole(literal, roleOptions(assertion.text)));
      count += await countStageFrameRoleMatches(page, literal, assertion.text);
    }
  }
  if (!assertion.testId && !assertion.component && !assertion.role) {
    count += await safeCount(page.getByTestId ? page.getByTestId("ui-node") : page.locator(attrSelector("data-testid", "ui-node")));
  }
  if (assertion.text && count === 0) {
    const body = page.locator("body");
    const text = await body.textContent?.();
    if (textMatches(assertion.text, text ?? undefined)) count += await safeCount(body);
  }
  return count;
}

async function countStageFrameRoleMatches(page: E2ePage, role: string, text: TextMatcher | undefined): Promise<number> {
  const frame = page.frameLocator?.('iframe#vendo-stage, iframe[title="Vendo stage"]');
  if (!frame) return 0;
  return safeCount(frame.getByRole(role, roleOptions(text)));
}

async function countErrorDomSignals(page: E2ePage): Promise<number> {
  const hardErrors = await safeCount(page.locator(hardErrorSelector));
  const stageErrors = page.frameLocator
    ? await safeCount(page.frameLocator('iframe#vendo-stage, iframe[title="Vendo stage"]').locator(stageErrorSelector))
    : 0;
  const toasts = page.locator(".fl-toast:visible");
  const toastCount = await safeCount(toasts);
  if (toastCount === 0) return hardErrors + stageErrors;
  const text = await toasts.textContent?.();
  return hardErrors + stageErrors + (text && errorToastText.test(text) ? toastCount : 0);
}

function viewMatches(assertion: Extract<ConversationAssertion, { kind: "view-rendered" }>, view: E2eViewSignal): boolean {
  if (view.visible === false) return false;
  if (assertion.component && !textMatches(assertion.component, view.component)) return false;
  if (assertion.role && !textMatches(assertion.role, view.role)) return false;
  if (assertion.testId && !textMatches(assertion.testId, view.testId)) return false;
  if (assertion.text && !textMatches(assertion.text, view.text)) return false;
  return true;
}

function roleOptions(text: TextMatcher | undefined): { name?: string | RegExp } | undefined {
  if (!text) return undefined;
  if (typeof text === "string") return { name: text };
  if (text.regex) return { name: new RegExp(text.regex, "i") };
  const exact = text.exact ?? text.equals;
  if (exact) return { name: exact };
  if (text.contains) return { name: new RegExp(escapeRegex(text.contains), "i") };
  return undefined;
}

async function clickIfPresent(locator: E2eLocator): Promise<boolean> {
  if (await safeCount(locator) === 0 || !locator.click) return false;
  await (locator.first?.() ?? locator).click?.();
  return true;
}

async function safeCount(locator: E2eLocator): Promise<number> {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

async function captureObservableText(page: E2ePage): Promise<string | undefined> {
  try {
    return (await page.locator(".fl-msglist, [role='dialog'], body").textContent?.()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function closeSession(session: E2ePageSession | undefined): Promise<void> {
  if (!session) return;
  if (session.close) {
    await session.close();
    return;
  }
  await session.page.close?.();
}

function requestJson(request: E2eRequest): unknown {
  try {
    if (request.postDataJSON) return request.postDataJSON();
  } catch {
    // Fall back to raw post data.
  }
  const raw = request.postData?.();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function compilePathPattern(template: string): RegExp {
  const parts = template.split(/(\{[^}]+\})/g).map((part) =>
    part.startsWith("{") && part.endsWith("}") ? "[^/]+" : escapeRegex(part),
  );
  return new RegExp(`^${parts.join("")}$`);
}

function componentSelector(component: string): string {
  const kebab = kebabCase(component);
  return [
    attrSelector("data-vendo-component", component),
    attrSelector("data-component", component),
    attrSelector("data-generated-impl", component),
    attrSelector("data-testid", component),
    attrSelector("data-testid", kebab),
    attrSelector("data-testid", `host-${kebab}`),
  ].join(", ");
}

function attrSelector(name: string, value: string): string {
  return `[${name}=${JSON.stringify(value)}]`;
}

function literalMatcherValue(matcher: TextMatcher): string | undefined {
  if (typeof matcher === "string") return matcher;
  return matcher.exact ?? matcher.equals;
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function describeViews(views: readonly E2eViewSignal[]): string {
  if (views.length === 0) return "none";
  return views.map((view) =>
    [view.component, view.role, view.testId, view.text].filter(Boolean).join("/") || "unnamed-view",
  ).join(", ");
}

function urlPathname(url: string, baseUrl: string): string {
  try {
    return new URL(url, baseUrl).pathname;
  } catch {
    return url;
  }
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "conversation";
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
