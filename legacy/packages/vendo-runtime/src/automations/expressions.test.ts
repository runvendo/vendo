/**
 * Expression-layer tests: the JSONata safe profile, `{{ }}` interpolation with
 * whole-value raw resolution, bare guard evaluation, and the closed scope.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateGuard,
  resolveInput,
  validateExpression,
  ExpressionError,
  type ExpressionScope,
} from "./expressions.js";

const scope: ExpressionScope = {
  trigger: {
    merchant: "DoorDash",
    amountDollars: 87.4,
    hour: 1,
    direction: "debit",
    rows: [1, 2, 3],
  },
  steps: { fetch: { output: { data: [{ id: "t1" }, { id: "t2" }] } } },
  run: { id: "run-1", automationId: "auto-1", firedAt: "2026-07-01T08:14:00.000Z" },
  user: { id: "user-1", name: "Yousef" },
};

describe("resolveInput", () => {
  it("interpolates {{ }} inside strings, stringifying results", async () => {
    const out = await resolveInput(
      { text: "{{ user.name }} spent ${{ trigger.amountDollars }}" },
      scope,
    );
    expect(out).toEqual({ text: "Yousef spent $87.4" });
  });

  it("resolves a whole-value expression to the raw value, not a string", async () => {
    const out = await resolveInput(
      { items: "{{ trigger.rows }}", n: "{{ trigger.amountDollars }}" },
      scope,
    );
    expect(out).toEqual({ items: [1, 2, 3], n: 87.4 });
  });

  it("resolves nested objects and arrays, leaving non-template values alone", async () => {
    const out = await resolveInput(
      { a: { b: ["{{ trigger.hour }}", 5, "plain"] }, keep: true },
      scope,
    );
    expect(out).toEqual({ a: { b: [1, 5, "plain"] }, keep: true });
  });

  it("renders an absent reference as empty string in interpolation and undefined as whole value", async () => {
    const out = await resolveInput(
      { text: "x{{ trigger.nope }}y", raw: "{{ trigger.nope }}" },
      scope,
    );
    expect(out).toEqual({ text: "xy", raw: undefined });
  });

  it("throws ExpressionError naming the expression on JSONata syntax errors", async () => {
    await expect(resolveInput({ bad: "{{ trigger.( }}" }, scope)).rejects.toThrowError(
      ExpressionError,
    );
    await expect(resolveInput({ bad: "{{ trigger.( }}" }, scope)).rejects.toThrowError(
      /trigger\.\(/,
    );
  });

  it("caps the resolved output size", async () => {
    const bigScope: ExpressionScope = {
      ...scope,
      trigger: { big: "x".repeat(300_000) },
    };
    await expect(
      resolveInput({ v: "{{ trigger.big & trigger.big }}" }, bigScope),
    ).rejects.toThrowError(ExpressionError);
  });
});

describe("evaluateGuard", () => {
  it("evaluates a bare predicate against the scope", async () => {
    await expect(
      evaluateGuard("trigger.direction = 'debit' and trigger.hour < 5", scope),
    ).resolves.toBe(true);
    await expect(evaluateGuard("trigger.amountDollars > 500", scope)).resolves.toBe(false);
  });

  it("treats a guard referencing nothing as false, not a crash", async () => {
    await expect(evaluateGuard("trigger.nope = 'x'", scope)).resolves.toBe(false);
  });

  it("fails closed on non-boolean guard results", async () => {
    await expect(evaluateGuard("trigger.merchant", scope)).rejects.toThrowError(
      ExpressionError,
    );
  });
});

describe("validateExpression (safe profile, creation-time)", () => {
  it("accepts the spec's worked-example expressions", () => {
    expect(() =>
      validateExpression(
        "trigger.direction = 'debit' and trigger.hour >= 0 and trigger.hour < 5",
      ),
    ).not.toThrow();
    expect(() =>
      validateExpression("$fromMillis($toMillis(run.firedAt) - 7*24*60*60*1000)"),
    ).not.toThrow();
  });

  it("rejects $eval", () => {
    expect(() => validateExpression("$eval('1+1')")).toThrowError(ExpressionError);
  });

  it("rejects $eval smuggled through an alias binding (review P1)", () => {
    expect(() => validateExpression("($e := $eval; $e('1+1'))")).toThrowError(
      ExpressionError,
    );
  });

  it("rejects regex literals (synchronous ReDoS beats the async time cap)", () => {
    expect(() => validateExpression("$contains(trigger.x, /(a+)+$/)")).toThrowError(
      ExpressionError,
    );
    expect(() => validateExpression("trigger.x ~> /a+/")).toThrowError(ExpressionError);
  });

  it("rejects nondeterministic builtins ($now/$millis/$random/$shuffle)", () => {
    for (const expr of ["$now()", "$millis()", "$random()", "$shuffle([1,2])"]) {
      expect(() => validateExpression(expr), expr).toThrowError(ExpressionError);
    }
  });

  it("rejects unknown builtins by allowlist, allowing local bindings", () => {
    expect(() => validateExpression("$definitelyNotABuiltin(1)")).toThrowError(
      ExpressionError,
    );
    // Local bindings introduced with := stay usable.
    expect(() =>
      validateExpression('($hay := $lowercase(trigger.m); $contains($hay, "d"))'),
    ).not.toThrow();
  });

  it("rejects inline function definitions", () => {
    expect(() => validateExpression("(function($x){ $x })(1)")).toThrowError(
      ExpressionError,
    );
  });

  it("rejects expressions over the length cap", () => {
    expect(() => validateExpression(`'a' & ${"'b' & ".repeat(400)}'c'`)).toThrowError(
      ExpressionError,
    );
  });

  it("rejects syntax errors with the offending expression in the message", () => {
    expect(() => validateExpression("trigger.(")).toThrowError(/trigger\.\(/);
  });
});
