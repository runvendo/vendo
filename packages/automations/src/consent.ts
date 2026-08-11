/**
 * 07 §3's grant capture, from both ends: the asks arming raises, the ask a
 * firing raises when it meets a permission nobody granted, and the one decision
 * subscriber that turns either into a standing grant.
 *
 * Lifted out of `createAutomationsEngine` unchanged.
 */
import {
  descriptorHash,
  serviceToolPhrase,
  serviceToolSlug,
  USE_SERVICE_TOOL,
  VendoError,
  withheldFromUnattended,
  withResolvedRisk,
  type AppDocument,
  type ApprovalRequest,
  type RunContext,
  type Step,
  type ToolDescriptor,
  type Trigger,
  type VendoRecord,
} from "@vendoai/core";
import type { AppRowsAccess } from "./app-rows.js";
import type { ArmedAccess } from "./armed.js";
import type { EngineBase } from "./engine-context.js";
import type { GrantsAccess } from "./grants.js";
import { allRecords, clone, id, parseRunRecord } from "./rows.js";
import type { RunRowsAccess } from "./run-rows.js";
import { declaredSurface } from "./sponsorship.js";
import { consentKey, declaredSlug } from "./steps.js";
import {
  APPROVALS,
  CAPTURES,
  RUNS,
  approvalRowSchema,
  captureSchema,
  type Capture,
  type ConsentItem,
  type InternalRunRecord,
} from "./types.js";

export type ConsentDeps = {
  base: EngineBase;
  appRows: AppRowsAccess;
  armed: ArmedAccess;
  grants: GrantsAccess;
  runRows: RunRowsAccess;
};

export interface ConsentAccess {
  /** A capture row, keyed by the approval it is the ask for. */
  writeCapture(approvalId: string, capture: Capture): Promise<void>;
  /** Is this approval still an open question? */
  isPendingAsk(approvalId: string): Promise<boolean>;
  /** Every still-pending capture for the subject, parsed. */
  pendingCaptures(subject: string): Promise<Array<{ id: string; data: Capture }>>;
  /** Claim the approval's one-time transition before granting anything. */
  spendApproval(record: VendoRecord): Promise<boolean>;
  /** The guard's decision subscriber: mint, clear, and disarm on a bare no. */
  handleDecision(approvalId: string, approved: boolean): Promise<void>;
  /** The tools a consent moment covers. */
  consentSurface(trigger: Trigger, byName: Map<string, ToolDescriptor>): Promise<ConsentItem[]>;
  /** 07 §3 — the asks arming has to raise for this subject. */
  captureGrants(
    doc: AppDocument,
    trigger: Trigger,
    byName: Map<string, ToolDescriptor>,
    ctx: RunContext,
  ): Promise<{ missing: ApprovalRequest[]; grantSetId: string }>;
  /** A step met a permission nobody has granted. The run ends HERE, loudly. */
  needsPermission(
    run: InternalRunRecord,
    ctx: RunContext,
    step: Step,
    approvalId: string,
  ): Promise<void>;
}

type CaptureRows = Pick<ConsentAccess, "writeCapture" | "isPendingAsk" | "pendingCaptures">;

/** The capture collection itself: the row a pending ask is remembered by, and
 *  the two reads that say which asks are still open. */
const createCaptureRows = ({ base: { engine } }: Pick<ConsentDeps, "base">): CaptureRows => {
  /** A capture row, keyed by the approval it is the ask for. Captures are a
   *  GENERIC collection and the 02-store §5 erase cascade finds generic rows by
   *  their refs, so the refs are derived HERE rather than at each writer: an
   *  unref'd capture outlives both the person who was asked and the app that
   *  asked. (Approvals need none: `vendo_approvals` is reserved, derives its own
   *  refs, and is erased by its subject column.) */
  const writeCapture = async (approvalId: string, capture: Capture): Promise<void> => {
    await engine.put(CAPTURES, {
      id: approvalId,
      data: { ...capture },
      refs: { subject: capture.subject, app_id: capture.appId, trigger_id: capture.triggerId },
    });
  };

  /** Is this approval still an open question? A capture whose approval is gone
   *  or already decided is stale, and stale asks are not what a person is
   *  waiting on. */
  const isPendingAsk = async (approvalId: string): Promise<boolean> => {
    const approval = await engine.get(APPROVALS, approvalId);
    if (approval === null) return false;
    const parsed = approvalRowSchema.safeParse(approval.data);
    return parsed.success && parsed.data.status === "pending" && parsed.data.voidedAt === undefined;
  };

  /** Every still-pending capture for the subject, parsed — the outstanding
   *  grant sets. Captures are engine-owned and deleted on decision, so
   *  "capture exists" ≈ "ask is pending"; volume stays tiny (undecided asks
   *  only), so an unindexed scan is fine on every adapter. */
  const pendingCaptures = async (subject: string): Promise<Array<{ id: string; data: Capture }>> => {
    const records = await allRecords(engine, CAPTURES);
    const captures: Array<{ id: string; data: Capture }> = [];
    for (const record of records) {
      const parsed = captureSchema.safeParse(record.data);
      if (parsed.success && parsed.data.subject === subject) captures.push({ id: record.id, data: parsed.data });
    }
    return captures;
  };

  return { writeCapture, isPendingAsk, pendingCaptures };
};

/** The one `onApprovalDecision` half: spend the approval, mint the standing
 *  grant, and disarm a consent moment that ended with nothing granted. */
const createDecisionSubscriber = (
  deps: Pick<ConsentDeps, "base" | "appRows" | "armed" | "grants">
    & Pick<CaptureRows, "pendingCaptures">,
): Pick<ConsentAccess, "spendApproval" | "handleDecision"> => {
  const { base: { config, engine, iso }, appRows, armed } = deps;
  const { grants, pendingCaptures } = deps;
  /**
   * Spends the approval this consent moment rode in on — through the guard when
   * it offers the seam, so the spend contends with a concurrent
   * `approvals.revoke` on the one transition instead of racing beside it. False
   * means DO NOT grant: the person took the yes back, or someone else already
   * spent it.
   *
   * KNOWN LIMIT — the fallback cannot linearize. A custom Guard that does not
   * offer `spendApproval` exposes no way to claim the approval's one-time
   * transition, so this path is back to reading the row and writing it: it
   * refuses a take-back it can see and writes the row back whole (no stripped
   * `deniedBy`/`voidedAt`), but a revoke landing inside that window can still
   * lose to the grant mint. Every Guard in this repo — the only one hosts get
   * unless they write their own — has the seam, and a host that replaces the
   * guard wholesale already owns its own consent bookkeeping. Not chased.
   */
  const spendApproval = async (record: VendoRecord): Promise<boolean> => {
    const data = approvalRowSchema.parse(record.data);
    if (config.guard.spendApproval !== undefined) {
      return await config.guard.spendApproval(record.id, data.request.ctx.principal) === "spent";
    }
    if (data.voidedAt !== undefined) return false;
    await engine.put(APPROVALS, {
      id: record.id,
      data: { ...data, consumedAt: iso() },
    });
    return true;
  };

  const handleDecision = async (approvalId: string, approved: boolean): Promise<void> => {
    const capture = await engine.get(CAPTURES, approvalId);
    if (capture !== null) {
      const parsed = captureSchema.parse(capture.data);
      const approval = await engine.get(APPROVALS, approvalId);
      if (approved && approval !== null) {
        const data = approvalRowSchema.parse(approval.data);
        // Spend before granting: a yes the person took back at this instant
        // must arm nothing, and only one of the two can win the transition.
        if (await spendApproval(approval)) await grants.mintGrant(data.request, parsed.triggerId);
      }
      await engine.delete(CAPTURES, approvalId);
      if (!approved) {
        // Deny is transactional at the DECISION (criterion 19, deny half),
        // but disarms ONLY a consent moment that ended with NOTHING granted:
        // no capture asks left pending for the trigger and no live
        // automation-source grant held. A partially granted automation stays
        // armed — its ungranted steps FAIL LOUD at fire time (05 §6, J5) and
        // ask again there. Scoped to the TRIGGER: saying no to one
        // trigger's ask must never disarm a sibling that is running fine.
        const outstanding = (await pendingCaptures(parsed.subject)).some((candidate) =>
          candidate.data.appId === parsed.appId && candidate.data.triggerId === parsed.triggerId);
        if (
          !outstanding
          && !(await grants.anyLiveAutomationGrant(parsed.subject, parsed.appId, parsed.triggerId))
        ) {
          const found = await appRows.appRecord(parsed.appId);
          if (found !== null && found.row.subject === parsed.subject && found.row.enabled) {
            await armed.disarmTrigger(found.record, found.row, parsed.triggerId);
          }
        }
      }
      return;
    }
    const approval = await engine.get(APPROVALS, approvalId);
    if (approval === null || !approved) return;
    const data = approvalRowSchema.parse(approval.data);
    if (
      data.status === "approved"
      && data.consumedAt === undefined
      && data.request.ctx.venue === "automation"
      && data.request.ctx.appId !== undefined
    ) {
      // An away approval nothing captured — an AGENTIC run's own ask (a steps
      // run writes a capture at the miss, so it never reaches here). Approval
      // arms the app-bound authority for the next firing; it does not resume
      // anything, which is now the law everywhere rather than an agentic
      // exception: the failed run stays failed, and the remedy is `runs.rerun`.
      //
      // The trigger comes from the RUN this approval was raised inside: an away
      // approval carries its run id on the context (`trigger.runId`), and the
      // run row is the only thing that knows which of the app's triggers fired.
      // Without it the grant would be app-wide and the next firing of a DIFFERENT
      // trigger would inherit authority nobody consented to for it.
      const runId = data.request.ctx.trigger?.runId;
      const runRow = runId === undefined ? null : await engine.get(RUNS, runId);
      const triggerId = runRow === null ? undefined : parseRunRecord(runRow).triggerId;
      if (await spendApproval(approval)) await grants.mintGrant(data.request, triggerId);
    }
  };

  return { spendApproval, handleDecision };
};

/** What a consent moment COVERS, before anything is asked. */
const createConsentSurface = (): Pick<ConsentAccess, "consentSurface"> => {
  /** The tools a consent moment covers. Steps DECLARE their surface; an agentic
   *  run declares one too when it was authored with one (`run.tools`), and falls
   *  back to every bound descriptor THE LAW would still let it reach away when it
   *  was not.
   *
   *  The connector dispatcher never enters as ITSELF, whichever kind of run this
   *  is: a tool-wide grant on it would be consent to the broker's whole catalog
   *  behind a single card. A steps run contributes one item per SERVICE ACTION it
   *  names; an agentic run contributes one per service-action slug in its
   *  declaration, which is exactly the same width. Anything either one reaches
   *  beyond that parks at fire time like any ungranted away call, and its
   *  approval accretes the per-slug grant. */
  const consentSurface = async (
    trigger: Trigger,
    byName: Map<string, ToolDescriptor>,
  ): Promise<ConsentItem[]> => {
    if (trigger.run.kind === "agentic") {
      const declared = trigger.run.tools;
      if (declared === undefined) {
        // The fallback is wide, but it is not DISHONEST: a tool §12 withholds
        // from every unattended run can never be the thing this grant permits,
        // so "allow this while you're away" is a question with no true answer.
        // The predicate is core's own `withheldFromUnattended` — the SAME one
        // `projectableForRun` filters the firing through — so the card and the
        // run cannot disagree about what may never happen away.
        return [...byName.values()]
          .filter((descriptor) => descriptor.name !== USE_SERVICE_TOOL
            && !withheldFromUnattended(descriptor))
          .map(({ name }) => ({ tool: name }));
      }
      const items = new Map<string, ConsentItem>();
      for (const name of declared) {
        // Declaring the dispatcher BY NAME buys nothing on purpose: it is the one
        // name whose tool-wide grant would be the broker's whole catalog behind a
        // single card. Name the actions instead.
        if (name === USE_SERVICE_TOOL) continue;
        // A declared name is a HOST TOOL when the bound surface has one by that
        // name, and a service action otherwise — the two namespaces are disjoint
        // by construction (bound tools match `TOOL_NAME_PATTERN`; broker slugs are
        // never bound). A name that is neither, on a deployment with no dispatcher
        // bound, enters under its OWN name so capture refuses it by that name
        // rather than as a nonsense slug.
        const item: ConsentItem = byName.has(name) || !byName.has(USE_SERVICE_TOOL)
          ? { tool: name }
          : { tool: USE_SERVICE_TOOL, slug: name };
        items.set(consentKey(item), item);
      }
      return [...items.values()];
    }
    const items = new Map<string, ConsentItem>();
    for (const tool of declaredSurface(trigger)) {
      if (tool !== USE_SERVICE_TOOL) items.set(tool, { tool });
    }
    for (const step of trigger.run.steps) {
      const slug = await declaredSlug(step);
      if (slug === undefined) continue;
      const item: ConsentItem = { tool: USE_SERVICE_TOOL, slug };
      items.set(consentKey(item), item);
    }
    return [...items.values()];
  };

  return { consentSurface };
};

/** 07 §3's arming half: the asks enable() has to raise for this subject. */
const createGrantCapture = (
  deps: Pick<ConsentDeps, "base" | "grants">
    & Pick<CaptureRows, "writeCapture" | "pendingCaptures">
    & Pick<ConsentAccess, "consentSurface">,
): Pick<ConsentAccess, "captureGrants"> => {
  const { base: { config, engine, iso }, grants, writeCapture, pendingCaptures, consentSurface } = deps;
  /** The tools a consent moment has to ask THIS subject about: the automation's
   *  surface minus whatever they already hold a live standing grant for.
   *
   *  One caller (07 §3): enable(), where the person arming the automation
   *  approves its reads and writes AS THEMSELVES. */
  const captureGrants = async (
    doc: AppDocument,
    trigger: Trigger,
    byName: Map<string, ToolDescriptor>,
    ctx: RunContext,
  ): Promise<{ missing: ApprovalRequest[]; grantSetId: string }> => {
    const appId = doc.id;
    const triggerId = trigger.id;
    const subject = ctx.principal.subject;
    const surface = await consentSurface(trigger, byName);
    // One grant SET per TRIGGER: re-enables reuse that trigger's still-pending
    // asks (and their set id) instead of minting duplicates for the same
    // (appId, triggerId, tool); a fresh set id is minted only when nothing is
    // pending. Scoped to the trigger, because a sibling trigger's pending ask
    // for the same tool is a different question about different steps.
    const pendingForApp = new Map(
      (await pendingCaptures(subject))
        .filter((capture) => capture.data.appId === appId && capture.data.triggerId === triggerId)
        .map((capture) => [consentKey(capture.data), capture]),
    );
    const grantSetId = [...pendingForApp.values()]
      .map((capture) => capture.data.grantSetId)
      .find((value) => value !== undefined) ?? id("gset_");
    const missing: ApprovalRequest[] = [];
    for (const item of surface) {
      const { tool, slug } = item;
      const authored = byName.get(tool);
      if (authored === undefined) throw new VendoError("validation", `unknown tool in automation: ${tool}`);
      // The descriptor the GUARD will see at fire time, not the authored one:
      // the dispatcher's own label is `ungraded` and the broker's per-slug tag
      // arrives through the risk resolver. Grading it here is what makes the
      // consent card show the real grade AND makes the minted grant's
      // descriptorHash the one the guard recomputes on the away call — hash the
      // authored label instead and the grant is invalidated on first use.
      const descriptor = slug === undefined
        ? authored
        : withResolvedRisk(
            authored,
            await config.resolveRisk?.({ id: id("call_"), tool, args: { slug } }, authored, ctx),
          );
      if (await grants.liveGrant(subject, appId, triggerId, descriptor, slug)) continue;
      const pending = pendingForApp.get(consentKey(item));
      if (pending !== undefined) {
        const approval = await engine.get(APPROVALS, pending.id);
        const parsed = approval === null ? undefined : approvalRowSchema.safeParse(approval.data);
        if (parsed?.success === true && parsed.data.status === "pending") {
          // Adopt pre-set rows (and any stray sibling) into THE app's set so
          // one decision can settle everything outstanding.
          if (pending.data.grantSetId !== grantSetId) {
            await writeCapture(pending.id, { ...pending.data, grantSetId });
          }
          missing.push(clone(parsed.data.request));
          continue;
        }
        // A capture whose approval is gone or already decided is stale —
        // clear it and fall through to a fresh mint.
        await engine.delete(CAPTURES, pending.id);
      }
      const request: ApprovalRequest = {
        id: id("apr_"),
        // The slug rides on the CALL, not on the descriptor: it is what the
        // grant is scoped to, and the descriptor is hashed.
        call: { id: id("call_"), tool, args: slug === undefined ? {} : { slug } },
        descriptor: clone(descriptor),
        inputPreview: `Allow "${doc.name}" to ${slug === undefined ? `use ${tool}` : serviceToolPhrase(slug)}`
          + " while you're away (standing, this app only)",
        ctx: {
          principal: clone(ctx.principal),
          venue: "automation",
          presence: "present",
          appId,
        },
        createdAt: iso(),
      };
      await engine.put(APPROVALS, {
        id: request.id,
        data: { request, status: "pending", sessionId: ctx.sessionId },
      });
      await writeCapture(request.id, {
        appId,
        triggerId,
        subject,
        tool,
        ...(slug === undefined ? {} : { slug }),
        descriptorHash: descriptorHash(descriptor),
        grantSetId,
      });
      missing.push(request);
    }
    return { missing, grantSetId };
  };

  return { captureGrants };
};

/** The fire-time half: a step met a permission nobody granted. */
const createPermissionMiss = (
  deps: Pick<ConsentDeps, "base" | "runRows">
    & Pick<CaptureRows, "writeCapture" | "isPendingAsk" | "pendingCaptures">,
): Pick<ConsentAccess, "needsPermission"> => {
  const { base: { config, engine }, runRows, writeCapture, isPendingAsk, pendingCaptures } = deps;
  /**
   * A step met a permission nobody has granted. The run ends HERE, loudly.
   *
   * Two things happen, and the order matters: the ask the guard just raised is
   * written as a CAPTURE first — the same row arming writes, so `handleDecision`
   * mints the standing grant through the one path both doors already share, and
   * the surfaces that project "waiting on N permissions" count this ask too —
   * and only then does the run land on its terminal error row. A crash between
   * the two leaves a capture whose approval is still pending, which the next
   * enable() adopts into its set; a crash the other way round would leave a run
   * telling someone to grant something no surface can find.
   *
   * ONE capture per thing-to-allow, though, and exactly one ASK: when the person
   * is already being asked exactly this — an arming ask for the same tool (and
   * service action) that nobody has answered yet — only one of the pair may stay
   * open. Two rows for one question count one permission as two on every surface
   * that projects the outstanding asks, and settle as two grants for authority
   * the person allowed once.
   *
   * WHICH one survives is not a toss-up. The run's ask is raised inside the
   * firing and carries `presence: "away"`, the `appId` and its run id; the
   * arming ask is a present-time row with none of that. Away provenance is what
   * every away-authority rule is enforced against, so the run's ask is the
   * survivor and the arming ask is superseded — its capture moved onto the
   * survivor (same grant set, so the question stays one question) and the ask
   * itself closed with the same feature-detected `abandonApprovals` the chat
   * door uses for an ask nobody needs answered. Order matters again here: the
   * capture moves BEFORE the ask is closed, so the decision subscriber finds no
   * capture and cannot mistake a supersede for a person's denial — which would
   * disarm an automation nobody said no to.
   *
   * The two sentences part ways on purpose (§16 law 3): `summary` is rendered
   * verbatim to whoever owns the automation, so it says what happened and what
   * to do; `error.message` names the TOOL, which is a developer's word, and
   * rides the dev-mode rail — with `tool`/`slug` beside it so a surface can
   * offer Grant & re-run without parsing a sentence.
   */
  const needsPermission = async (
    run: InternalRunRecord,
    ctx: RunContext,
    step: Step,
    approvalId: string,
  ): Promise<void> => {
    const approval = await engine.get(APPROVALS, approvalId);
    const parsed = approval === null ? undefined : approvalRowSchema.safeParse(approval.data);
    const request = parsed?.success === true ? parsed.data.request : undefined;
    const slug = request === undefined ? undefined : serviceToolSlug(request.call);
    if (request !== undefined) {
      const forTrigger = (await pendingCaptures(ctx.principal.subject))
        .filter((capture) => capture.data.appId === run.appId && capture.data.triggerId === run.triggerId);
      const asked = forTrigger.find((capture) =>
        consentKey(capture.data) === consentKey({ tool: request.call.tool, ...(slug === undefined ? {} : { slug }) }));
      const live = asked === undefined ? false : await isPendingAsk(asked.id);
      // The run's own ask is ALWAYS the captured one — whether the arming ask it
      // replaces was already decided (stale capture) or is still open (a live
      // one being superseded). One grant set per (app, trigger), shared with
      // arming: a person deciding this ask settles everything else outstanding
      // for the same trigger.
      await writeCapture(approvalId, {
        appId: run.appId,
        triggerId: run.triggerId,
        subject: ctx.principal.subject,
        tool: request.call.tool,
        ...(slug === undefined ? {} : { slug }),
        descriptorHash: descriptorHash(request.descriptor),
        grantSetId: forTrigger[0]?.data.grantSetId ?? id("gset_"),
      });
      if (asked !== undefined && asked.id !== approvalId) {
        // The capture moves off the ask being replaced BEFORE that ask is
        // touched: a capture on a decided approval keeps a settled question open
        // on the panel, and — when the ask below is closed — a capture still
        // sitting here would make the decision subscriber read a supersede as a
        // person's denial and disarm an automation nobody said no to.
        await engine.delete(CAPTURES, asked.id);
        // A STILL-OPEN arming ask for this same thing is now redundant: the
        // question is one question, and the run's ask is the one that carries
        // where it was met (`presence: "away"`, the appId, the run id). Left
        // pending it kept "waiting on 1 permission" and a live Allow/Deny card
        // for a permission already granted, kept the needs-you badge lit, and
        // survived a reload — nothing closed it but the hour-long TTL sweep.
        //
        // `abandonApprovals` is the existing verb for an ask nobody needs
        // answered. It denies as `system`, which is explicitly NOT a standing no
        // (the guard only enforces `deniedBy: "human"`), mints nothing, and is
        // idempotent. Optional on the seam, so feature-detected the same way the
        // chat door does it — a guard without it keeps the pre-existing
        // behaviour, with the TTL sweep as the backstop.
        if (live) await config.guard.abandonApprovals?.([asked.id], ctx);
      }
    }
    const named = slug === undefined ? `use ${step.tool}` : serviceToolPhrase(slug);
    await runRows.terminal(
      run,
      ctx,
      "error",
      `stopped at ${step.id}: it needs a permission nobody has allowed yet`
      + " — allow it and run this again",
      {
        code: "needs-permission",
        message: `needs permission to ${named}`,
        tool: step.tool,
        ...(slug === undefined ? {} : { slug }),
      },
    );
  };

  return { needsPermission };
};

export const createConsent = (deps: ConsentDeps): ConsentAccess => {
  const captures = createCaptureRows(deps);
  const surface = createConsentSurface();
  return {
    ...captures,
    ...surface,
    ...createDecisionSubscriber({ ...deps, ...captures }),
    ...createGrantCapture({ ...deps, ...captures, ...surface }),
    ...createPermissionMiss({ ...deps, ...captures }),
  };
};
