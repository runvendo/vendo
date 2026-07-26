import type { LanguageModel } from "ai";

/**
 * Scripted LanguageModel double for judge tests — a local re-implementation
 * of the shape of packages/guard/test/fixtures/scripted-judge-model.ts (that
 * fixture is not exported; never import across package test dirs). Each
 * doGenerate call consumes the next script; the last script repeats once
 * exhausted.
 */

export type JudgeModelScript =
  | { json: unknown }
  | { text: string }
  | { error: Error };

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

export class ScriptedJudgeModel {
  readonly specificationVersion = "v2" as const;
  readonly provider = "vendo-test";
  readonly modelId = "scripted-knowledge-judge";
  readonly supportedUrls = {};
  readonly doGenerateCalls: unknown[] = [];
  #index = 0;

  constructor(private readonly scripts: JudgeModelScript[]) {}

  async doGenerate(options: unknown) {
    this.doGenerateCalls.push(options);
    const script = this.scripts[Math.min(this.#index++, this.scripts.length - 1)];
    if (!script) throw new Error("scripted judge exhausted");
    if ("error" in script) throw script.error;
    const text = "text" in script ? script.text : JSON.stringify(script.json);
    return {
      content: [{ type: "text" as const, text }],
      finishReason: "stop" as const,
      usage,
      warnings: [],
    };
  }

  async doStream(): Promise<never> {
    throw new Error("streaming is not used by the knowledge judge");
  }
}

export function scriptedJudgeModel(...scripts: JudgeModelScript[]): ScriptedJudgeModel {
  return new ScriptedJudgeModel(scripts);
}

export function asLanguageModel(model: ScriptedJudgeModel): LanguageModel {
  return model as unknown as LanguageModel;
}
