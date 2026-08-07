import type { LanguageModel } from "ai";

export type JudgeScript =
  | { action: "run" | "ask" | "block"; rationale: string }
  | { error: Error }
  | { hang: true };

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

export class ScriptedJudgeModel {
  readonly specificationVersion = "v2" as const;
  readonly provider = "vendo-test";
  readonly modelId = "scripted-judge";
  readonly supportedUrls = {};
  readonly doGenerateCalls: unknown[] = [];
  #index = 0;

  constructor(private readonly scripts: JudgeScript[]) {}

  async doGenerate(options: unknown) {
    this.doGenerateCalls.push(options);
    const script = this.scripts[Math.min(this.#index++, this.scripts.length - 1)];
    if (!script) throw new Error("scripted judge exhausted");
    if ("error" in script) throw script.error;
    if ("hang" in script) return await new Promise<never>(() => {});
    return {
      content: [{ type: "text" as const, text: JSON.stringify(script) }],
      finishReason: "stop" as const,
      usage,
      warnings: [],
    };
  }

  async doStream(): Promise<never> {
    throw new Error("streaming is not used by vendoAutoJudge");
  }
}

export function scriptedJudgeModel(...scripts: JudgeScript[]): ScriptedJudgeModel {
  return new ScriptedJudgeModel(scripts);
}

export function throwingJudgeModel(message = "judge unavailable"): ScriptedJudgeModel {
  return scriptedJudgeModel({ error: new Error(message) });
}

export function hangingJudgeModel(): ScriptedJudgeModel {
  return scriptedJudgeModel({ hang: true });
}

export function asLanguageModel(model: ScriptedJudgeModel): LanguageModel {
  return model as unknown as LanguageModel;
}
