import { z } from "zod";

/** 01-core §1 */
export type AppId = string;

/** 01-core §1 */
export type GrantId = string;

/** 01-core §1 */
export type ApprovalId = string;

/** 01-core §1 */
export type RunId = string;

/** 01-core §1 */
export type ThreadId = string;

/**
 * One turn's stable identity — the join key nothing had.
 *
 * A thread is a conversation and a run is a metering row; neither says "these
 * audit rows, that mirrored call, this beat and that view all came out of the
 * same turn". Minted where a `Turn` is constructed, carried on the `RunContext`
 * so every audit row a turn produces is joinable, and OPAQUE to adapters —
 * nobody parses it, and nothing branches on its shape.
 */
export type TurnId = string;

/** 01-core §1 */
export type IsoDateTime = string;

/** 01-core §1 */
export type Json = unknown;

/** 01-core §1 */
export type JsonSchema = Record<string, unknown>;

/** 01-core §1 */
export const appIdSchema = z.string().regex(/^app_.+$/) satisfies z.ZodType<AppId>;

/** 01-core §1 */
export const grantIdSchema = z.string().regex(/^grt_.+$/) satisfies z.ZodType<GrantId>;

/** 01-core §1 */
export const approvalIdSchema = z.string().regex(/^apr_.+$/) satisfies z.ZodType<ApprovalId>;

/** 01-core §1 */
export const runIdSchema = z.string().regex(/^run_.+$/) satisfies z.ZodType<RunId>;

/** 01-core §1 */
export const threadIdSchema = z.string().regex(/^thr_.+$/) satisfies z.ZodType<ThreadId>;

/**
 * The prefix a WARM turn's thread id carries — and the whole of the seam between
 * the warm door and a session-owning adapter.
 *
 * `HarnessTurns.warm` mints one id per warm call and drops it the moment its
 * one-token probe ends, so an adapter that pools per conversation would park a
 * real machine under a conversation nobody will ever ask for again. The
 * `Harness` contract is frozen — a warm turn IS an ordinary turn — so the id is
 * the only thing that can carry the fact, and `claude-code/box.ts` reads it to
 * park its box as a claimable spare instead.
 */
export const WARM_THREAD_PREFIX = "thr_warm";

/** 01-core §1 — unlike its neighbours this pins the WHOLE shape rather than a
 *  prefix: a turn id is minted in exactly one place, so there is no older,
 *  looser spelling to keep parsing. */
export const turnIdSchema = z.string().regex(/^trn_[0-9a-f]{32}$/) satisfies z.ZodType<TurnId>;

/** The one mint. `randomUUID` with the hyphens dropped is 32 lowercase hex —
 *  the same bytes the store's other ids ride on, spelled the way
 *  {@link turnIdSchema} reads. */
export const mintTurnId = (): TurnId => `trn_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;

/** 01-core §1 */
export const isoDateTimeSchema = z.string().datetime() satisfies z.ZodType<IsoDateTime>;

/** 01-core §1 */
export const jsonSchemaSchema = z.record(z.unknown()) satisfies z.ZodType<JsonSchema>;
