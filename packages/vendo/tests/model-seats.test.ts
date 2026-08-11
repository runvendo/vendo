import { VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { resolveModels } from "../src/models-config.js";

const named = (name: string): LanguageModel => ({ id: name } as unknown as LanguageModel);
const makeModel = (name?: string): LanguageModel => named(name ?? "ladder-default");

describe("seat vocabulary on the models block (build contract §4)", () => {
  it("accepts `default` as the name for what used to be `agent`", () => {
    const resolved = resolveModels({ models: { default: "sonnet" } }, makeModel);
    expect(resolved.agent.model).toEqual(named("sonnet"));
  });

  it("accepts `fill` as the name for what used to be `paint`", () => {
    const resolved = resolveModels({ models: { fill: "haiku" } }, makeModel);
    expect(resolved.paint?.model).toEqual(named("haiku"));
  });

  it("keeps `judge` under its own name", () => {
    expect(() => resolveModels({ models: { judge: "haiku" } }, makeModel)).not.toThrow();
  });

  it("still honours the deprecated top-level `model` and `paint.model` shims", () => {
    const resolved = resolveModels({ model: named("legacy"), paint: { model: named("legacy-paint") } }, makeModel);
    expect(resolved.agent.model).toEqual(named("legacy"));
    expect(resolved.paint?.model).toEqual(named("legacy-paint"));
  });

  it("validates every seat-named slot", () => {
    expect(() => resolveModels({ models: { default: "  " } }, makeModel)).toThrow(VendoError);
    expect(() => resolveModels({ models: { fill: "  " } }, makeModel)).toThrow(VendoError);
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
