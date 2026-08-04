import { VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { resolveModels } from "./models-config.js";

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

  it("still honours the legacy `agent` and `paint` keys for one minor", () => {
    const resolved = resolveModels({ models: { agent: "opus", paint: "haiku" } }, makeModel);
    expect(resolved.agent.model).toEqual(named("opus"));
    expect(resolved.paint?.model).toEqual(named("haiku"));
  });

  it("still honours the deprecated top-level `model` and `paint.model` shims", () => {
    const resolved = resolveModels({ model: named("legacy"), paint: { model: named("legacy-paint") } }, makeModel);
    expect(resolved.agent.model).toEqual(named("legacy"));
    expect(resolved.paint?.model).toEqual(named("legacy-paint"));
  });

  it("prefers the seat name when both vocabularies name the same seat", () => {
    // A host mid-migration should get the NEW key they just wrote, not the old
    // one they forgot to delete.
    const resolved = resolveModels({ models: { default: "new", agent: "old" } }, makeModel);
    expect(resolved.agent.model).toEqual(named("new"));
  });

  it("validates a seat-named slot as strictly as a legacy one", () => {
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
