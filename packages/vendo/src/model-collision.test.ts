import { VendoError } from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { resolveModels } from "./models-config.js";

/** Finding 16 — the boot error guarded `harnessOptionModel`, which no production
 *  path sets, while the collision a real host CAN create resolved silently. */
const named = (name: string): LanguageModel => ({ id: name } as unknown as LanguageModel);
const makeModel = (name?: string): LanguageModel => named(name ?? "ladder-default");

describe("the collision a real host can actually create is a boot error", () => {
  it("refuses the deprecated top-level `model` alongside `models.default`", () => {
    // Both name the model that thinks. Last-write-wins silently ignored one of
    // the host's two explicit instructions.
    expect(() => resolveModels({ model: named("legacy"), models: { default: "sonnet" } }, makeModel))
      .toThrow(VendoError);
  });

  it("names both knobs so the host knows which to delete", () => {
    expect(() => resolveModels({ model: named("legacy"), models: { default: "sonnet" } }, makeModel))
      .toThrow(/models\.default/);
  });

  it("refuses the deprecated `paint.model` alongside `models.fill`", () => {
    expect(() => resolveModels({ paint: { model: named("legacy") }, models: { fill: "haiku" } }, makeModel))
      .toThrow(VendoError);
  });

  it("still accepts the deprecated knobs ALONE, for one more minor", () => {
    expect(() => resolveModels({ model: named("legacy") }, makeModel)).not.toThrow();
    expect(() => resolveModels({ paint: { model: named("legacy") } }, makeModel)).not.toThrow();
  });

  it("still accepts the seat names alone", () => {
    expect(() => resolveModels({ models: { default: "sonnet", fill: "haiku" } }, makeModel)).not.toThrow();
  });

  it("leaves paint.disabled alone — it is not a model knob", () => {
    expect(() => resolveModels({ paint: { disabled: true }, models: { fill: "haiku" } }, makeModel)).not.toThrow();
  });

  it("keeps the legacy `agent` key working beside a different seat", () => {
    expect(() => resolveModels({ models: { agent: "opus", judge: "haiku" } }, makeModel)).not.toThrow();
  });
});
