import { VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { resolveModels } from "../src/models-config.js";

const named = (name: string): LanguageModel => ({ id: name } as unknown as LanguageModel);
const makeModel = (name?: string, options?: { slot?: string }): LanguageModel =>
  named(name ?? `ladder-${options?.slot ?? "agent"}`);

describe("seat vocabulary on the models block (build contract §4)", () => {
  it("gives each of the four jobs its own seat", () => {
    const resolved = resolveModels(
      { models: { default: "sonnet", apps: "opus", review: "haiku", judge: "flash" } },
      makeModel,
    );
    expect(resolved.agent.model).toEqual(named("sonnet"));
    expect(resolved.seats).toEqual({
      default: named("sonnet"),
      apps: named("opus"),
      review: named("haiku"),
      judge: named("flash"),
    });
  });

  it("validates every seat-named slot", () => {
    expect(() => resolveModels({ models: { default: "  " } }, makeModel)).toThrow(VendoError);
    expect(() => resolveModels({ models: { apps: "  " } }, makeModel)).toThrow(VendoError);
    expect(() => resolveModels({ models: { review: "  " } }, makeModel)).toThrow(VendoError);
  });

  it("boot-errors when a harness option and models.default both set the default seat", () => {
    expect(() => resolveModels(
      { models: { default: "sonnet" }, harnessOptionModel: named("opus") },
      makeModel,
    )).toThrow(VendoError);
  });

  it("does not boot-error when the harness option stands alone", () => {
    expect(() => resolveModels({ harnessOptionModel: named("opus") }, makeModel)).not.toThrow();
  });

  it("does not boot-error when the harness option meets an unrelated seat", () => {
    expect(() => resolveModels(
      { models: { judge: "haiku" }, harnessOptionModel: named("opus") },
      makeModel,
    )).not.toThrow();
  });
});
