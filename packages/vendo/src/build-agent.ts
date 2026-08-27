/**
 * THE BUILD LANE — `screen-agent.ts`'s other half, and the only place the
 * `AppBuilder` seam is filled.
 *
 * A screen agent answers `escalate` when an ask is bigger than a screen. Once —
 * and only once — the person has said yes to the standing card, this runs their
 * ask inside a disposable box: the in-box coding agent installs from npm, writes
 * the code, bundles it and tests it against reality, and the files it leaves
 * behind come home to be sealed. Single-phase, because the box's model key is
 * temporary (FINAL SPEC v1).
 *
 * THE BOX HOLDS ZERO STORE CREDENTIALS. It is handed the inference env the
 * session boxes get and nothing else — no store URL, no app token, no tool door
 * — so the only thing that can come out of it is files, and the HOST is what
 * writes them. That is a security invariant, not a preference: the box runs
 * code a person's words asked for.
 *
 * It lives in the umbrella for `screenAssembler`'s reason: only composition
 * holds both the box pool (`@vendoai/harnesses`) and the apps runtime.
 */
import {
  isVendoError,
  type AppId,
  type AppSourceFile,
  type RunContext,
} from "@vendoai/core";
import { buildFailureReason } from "@vendoai/apps";
import { renderBriefingPack } from "@vendoai/apps/contract";
import type { AppBuilder, BriefingPack, BuildOutcome, BuildRequest, BuiltFile } from "@vendoai/apps/contract";
import {
  BOX_WORKSPACE_ROOT,
  boxEgress,
  boxMachine,
  type SandboxAdapterLike,
} from "@vendoai/harnesses/claude-code/box";
import { BRIEF_SECTION } from "./screen-agent.js";

export interface AppBuilderDeps {
  sandbox: SandboxAdapterLike | undefined;
  /** The same env the session boxes get (`inferenceEnv`) — the box's model door,
   *  and deliberately nothing else. */
  boxEnv: () => Record<string, string>;
  /** THE briefing pack (`compose-surfaces.ts`), assembled once for both rungs.
   *  Absent only where nothing composed one, which is no deployment. */
  briefing?: (ctx: RunContext) => Promise<BriefingPack>;
  template?: string;
}

/**
 * What the build MINUTE may reach, on top of the inference host `boxEgress`
 * always adds. The registry and nothing more: this box is driven by the
 * person's own words, and the artifact it produces renders behind
 * `default-src 'none'`, so nothing it installs is allowed to phone home either.
 */
export const BUILD_ALLOWED_DOMAINS: readonly string[] = ["registry.npmjs.org"];

/**
 * Where a build works, in the two spellings the box has.
 *
 * `materialize` and `collect` speak WORKSPACE paths, which the box door maps
 * onto its disk under the mount root (`toDisk`,
 * `packages/harnesses/box/turn-routes.mjs`) — and `/user/**` is the only tree
 * that door carries back (`carriedBack`). The BRIEF cannot use that spelling:
 * the in-box agent has a shell, so it reads a leading `/` as the filesystem
 * root, sudo-creates `/user` there and bundles into a directory `collect` never
 * looks at. Measured live 2026-08-24 — a real 28 KB bundle on the box, an empty
 * collect, and "the build's own test did not pass" on every run.
 *
 * (The screen agent's identical-looking `/user/apps/<id>` is not a precedent:
 * its model writes through the host's workspace FAÇADE, which speaks workspace
 * paths, and never touches a disk.)
 */
const appDirectory = (appId: AppId): string => `/user/apps/${appId}`;
const diskDirectory = (appId: AppId): string => `${BOX_WORKSPACE_ROOT}${appDirectory(appId)}`;

/** What the frame boots, and the one file whose presence means the build worked:
 *  the brief tells the box to remove it if its own test does not pass. */
const ENTRY = "dist/app.js";

/** Everything this lane ever says about itself, in order — "progress = chat
 *  status lines only" (FINAL SPEC v1). Named so the seam that reads them back
 *  off the app row reads THESE rather than a copy of them. */
export const BUILD_STATUS_LINES = [
  "Starting a build machine…",
  "Writing the code, installing what it needs, and testing it…",
] as const;

/** The one capability gap that is this seam's own to report, in the person's
 *  terms. Third person: it surfaces as a system notice. */
const NO_SANDBOX = "This needs a real build machine, and this deployment has no sandbox adapter to boot one from.";
/** A box that died, was reaped, or was refused by the provider — including a
 *  meter's 402, which the box seam reports the same way. Never the ask's fault,
 *  so it must not read like a verdict on the request. */
const BOX_GONE = "the build machine went away before the build finished.";
/** The box came back having produced no entry, which the brief defines as "my
 *  own test did not pass". */
const NO_ENTRY = "the build's own test did not pass, so it produced nothing to seal.";

const encoder = new TextEncoder();

/** The stored source a RESEAL starts from, on the box's disk. Spilled files are
 *  left behind: the bytes live in a blob namespace this seam cannot reach, and
 *  reaching it would put a store credential in this lane. */
const checkoutOf = (source: Record<string, AppSourceFile> | undefined, directory: string) =>
  Object.entries(source ?? {}).flatMap(([path, file]) => file.text === undefined
    ? []
    : [{ path: `${directory}/${path}`, bytes: encoder.encode(file.text), readOnly: false }]);

/** `directory` is the DISK spelling — this text is read by a shell.
 *
 *  The test step NAMES the box's egress, because an agent told to verify against
 *  reality will otherwise go looking for the reality it knows. Measured live
 *  2026-08-27: four escalated builds died at 15.2–15.4 min against the 15-minute
 *  message budget — on asks as small as "show a QR code" — every one of them
 *  trying to install a browser for Playwright and then a native canvas, both
 *  unreachable past `BUILD_ALLOWED_DOMAINS`, and re-architecting the app between
 *  attempts. Ask weight was not the variable; the cul-de-sac costs the same
 *  whatever was asked for. The allowlist is the security boundary and does not
 *  move, so the brief tells the truth about it instead.
 *
 *  Two more of the same kind, measured the same day once the first was gone: the
 *  image's baked `@vendoai/ui` predates the frame protocol, so a build that used
 *  it lost the time to find that out; and `callHost` is named here as the way to
 *  reach host data, which sent an agent hunting this disk for a tool list that
 *  is deliberately absent (no `toolDoor`, below). `callHost` is real — it is a
 *  postMessage to the embedding page, so it answers at RUNTIME and never in
 *  here — so the brief says which side of that line it is on rather than
 *  dropping it and taking the capability with it.
 *
 *  `briefing` is the rendered pack, appended as its own SECTION on the same join
 *  the screen agent's brief uses: the instructions above it are this rung's own,
 *  the product knowledge below it is the bytes the other rung read. */
const briefFor = (request: BuildRequest, directory: string, briefing: string | undefined): string =>
  [`Build this for real, in ${directory}.

WHAT THE PERSON ASKED FOR, verbatim:
${request.prompt}

WHY A GENERATED SCREEN WAS NOT ENOUGH:
${request.why}

HOW IT SHIPS
- Write the source under ${directory}/src and install whatever npm packages it
  needs. Install @vendoai/ui from npm rather than using the copy already on this
  machine: the baked one predates the frame protocol below and does not have it.
- The document that serves your bundle is one <div id="root"></div>: mount into
  that element, and once your first render is really in the DOM (an empty mount
  measures as height 0, which the host renders as a collapsed frame) call
  startFrameProtocol(mount) from @vendoai/ui/kit. That is what sizes the frame
  and applies the host's brand tokens, and callHost(tool, args) from the same
  module is how the SHIPPED app reaches the host's data. Both speak to the page
  that embeds the app, so neither answers in here: there is no host on this
  machine and no tool list to read. Write against them and move on — looking for
  the host's tools on this disk finds nothing and costs you the build.
- Bundle it with esbuild to ${directory}/${ENTRY}: ONE self-contained file, no
  imports left at runtime and no network calls at all — the sealed bundle renders
  in an iframe where every request is blocked.
- Test what you built against reality, and fix what fails. Reality here is Node:
  this machine reaches the npm registry and nothing else, so no browser can be
  fetched or driven and nothing with a native binary will build. Render the
  bundle under a pure-JS DOM (jsdom) and assert what it produces; hunting for a
  real browser only spends the clock you need for the build.
- If your own test does not pass, DELETE ${directory}/${ENTRY} and stop. Its
  absence is how this host is told the build did not work; a broken one left
  behind is shipped to the person as if it worked.`, briefing]
    .filter((section): section is string => section !== undefined)
    .join(BRIEF_SECTION);

/** How a throw out of the box becomes the sentence on the person's failure card.
 *  `buildFailureReason` is the one classifier this record has (quota, timeout,
 *  a busy service), and it never surfaces a provider's raw words — but it has no
 *  sentence for a dead machine and would call that a generation failure, which
 *  sends the person to rewrite an ask that was fine. */
const failureOf = (error: unknown): BuildOutcome => {
  if (isVendoError(error) && error.code === "sandbox-unavailable") {
    return { kind: "failed", why: BOX_GONE, retryable: true };
  }
  const { reason, retryable } = buildFailureReason(error);
  return { kind: "failed", why: reason, retryable };
};

export function appBuilder(deps: AppBuilderDeps): AppBuilder {
  return {
    // The ONE gate: a composed sandbox adapter, and nothing else.
    available: () => deps.sandbox !== undefined,

    async build(request, ctx) {
      const { sandbox } = deps;
      if (sandbox === undefined) return { kind: "failed", why: NO_SANDBOX };
      const env = deps.boxEnv();
      const directory = appDirectory(request.appId);
      // Declared out here so the box is handed back even when the lane throws.
      let machine: Awaited<ReturnType<typeof boxMachine>> | undefined;
      try {
        request.onStatus?.(BUILD_STATUS_LINES[0]);
        machine = await boxMachine({
          sandbox,
          threadId: `build_${request.appId}`,
          env,
          allowedDomains: boxEgress(env, undefined, BUILD_ALLOWED_DOMAINS),
          ...(deps.template === undefined ? {} : { template: deps.template }),
        });
        await machine.materialize(checkoutOf(request.source, directory));
        request.onStatus?.(BUILD_STATUS_LINES[1]);
        const pack = await deps.briefing?.(ctx);
        // No `toolDoor`: this box reaches none of the host's tools, so there is
        // nothing for it to act with and no credential to act under.
        await machine.send({
          prompt: briefFor(request, diskDirectory(request.appId),
            pack === undefined ? undefined : renderBriefingPack(pack)),
          emit: () => undefined,
        });
        const collected = await machine.collect([
          `${directory}/${ENTRY}`,
          `${directory}/src/*`,
          `${directory}/package-lock.json`,
        ]);
        const files: BuiltFile[] = collected.map(({ path, bytes }) => ({ path: path.slice(directory.length + 1), bytes }));
        if (!files.some((file) => file.path === ENTRY)) return { kind: "failed", why: NO_ENTRY, retryable: true };
        return { kind: "built", files, entry: ENTRY };
      } catch (error) {
        return failureOf(error);
      } finally {
        // Back to the pool on its idle timer, which destroys it. Nothing leaves
        // the box but the files above.
        await machine?.release();
      }
    },
  };
}
