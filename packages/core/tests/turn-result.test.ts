import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decisionSchema,
  decisionsSchema,
  interruptionSchema,
  questionSchema,
  type TurnResult,
} from "../src/turn-result.js";

const toolCall = { id: "call_1", tool: "refund_invoice", args: { id: "inv_7" } };

describe("interruptionSchema", () => {
  it("accepts both arms and preserves unknown keys", () => {
    expect(interruptionSchema.safeParse({ id: "int_1", type: "approval", toolCall }).success).toBe(true);
    expect(
      interruptionSchema.parse({
        id: "int_2",
        type: "input",
        questions: [{ id: "q1", text: "Which account?", choices: ["checking", "savings"] }],
        note: "extra",
      }),
    ).toMatchObject({ note: "extra" });
  });

  it("rejects a type nothing renders, and an arm missing its payload", () => {
    expect(interruptionSchema.safeParse({ id: "int_3", type: "consent", toolCall }).success).toBe(false);
    expect(interruptionSchema.safeParse({ id: "int_4", type: "approval" }).success).toBe(false);
    expect(interruptionSchema.safeParse({ id: "int_5", type: "input" }).success).toBe(false);
  });
});

describe("questionSchema", () => {
  it("takes free text without choices, and rejects an empty question", () => {
    expect(questionSchema.safeParse({ id: "q1", text: "What is the reason?" }).success).toBe(true);
    expect(questionSchema.safeParse({ id: "q1", text: "" }).success).toBe(false);
  });
});

describe("decisionSchema", () => {
  it("accepts the two verdicts and an answers object, single- or multi-valued", () => {
    expect(decisionSchema.safeParse("approve").success).toBe(true);
    expect(decisionSchema.safeParse("deny").success).toBe(true);
    expect(decisionSchema.safeParse({ answers: { q1: "checking", q2: ["a", "b"] } }).success).toBe(true);
  });

  it("rejects anything that is neither verdict nor answers", () => {
    expect(decisionSchema.safeParse("maybe").success).toBe(false);
    expect(decisionSchema.safeParse({ approved: true }).success).toBe(false);
    expect(decisionSchema.safeParse({ answers: { q1: 42 } }).success).toBe(false);
  });

  it("keys a decisions map by interruption id", () => {
    expect(decisionsSchema.safeParse({ int_1: "approve", int_2: { answers: { q1: "x" } } }).success).toBe(true);
    expect(decisionsSchema.safeParse({ int_1: "maybe" }).success).toBe(false);
  });
});

describe("TurnResult", () => {
  type Result = TurnResult<{ refunded: string }, { id: string }>;

  it("narrows on status: each arm carries its own fields and only its own", () => {
    expectTypeOf<Extract<Result, { status: "ok" }>["output"]>().toEqualTypeOf<{ refunded: string }>();
    expectTypeOf<Extract<Result, { status: "stopped" }>["reason"]>().toEqualTypeOf<"aborted" | "maxToolCalls">();
    expectTypeOf<Extract<Result, { status: "error" }>["text"]>().toEqualTypeOf<"">();
    // Nothing ran, so there is no work to report.
    expectTypeOf<Extract<Result, { status: "error" }>>().not.toHaveProperty("toolCalls");
  });

  it("hands `resume` back whatever the second parameter binds — core never names a Turn", () => {
    expectTypeOf<ReturnType<Extract<Result, { status: "interrupted" }>["resume"]>>()
      .toEqualTypeOf<{ id: string }>();
  });
});
