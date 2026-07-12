import {
  VENDO_APP_FORMAT,
  VENDO_TREE_FORMAT,
  type AppDocument,
  type ComponentCatalog,
  type VendoTheme,
} from "@vendoai/core";
import type { LanguageModel } from "ai";

export interface GenerationDependencies {
  model: LanguageModel;
  catalog: ComponentCatalog;
  theme?: VendoTheme;
  designRules?: string;
}

export interface GenerationCreateInput {
  prompt: string;
}

export interface GenerationEditInput {
  app: AppDocument;
  instruction: string;
}

export type GeneratedAppDocument = Omit<AppDocument, "id">;

/** 06-apps §5 — replaceable generation seam; Lane D supplies the model-backed engine. */
export interface GenerationEngine {
  create(input: GenerationCreateInput, deps: GenerationDependencies): Promise<GeneratedAppDocument>;
  edit(input: GenerationEditInput, deps: GenerationDependencies): Promise<GeneratedAppDocument>;
}

const generatedName = (source: string): string => source.trim().slice(0, 60) || "Untitled app";

/** Lane B deterministic rung-1 placeholder used until Lane D installs generation. */
export const stubEngine: GenerationEngine = {
  async create(input) {
    return {
      format: VENDO_APP_FORMAT,
      name: generatedName(input.prompt),
      ui: "tree",
      tree: {
        formatVersion: VENDO_TREE_FORMAT,
        root: "root",
        nodes: [{
          id: "root",
          component: "Text",
          props: { text: "This app is being generated." },
        }],
      },
    };
  },
  async edit(input) {
    const { id, ...document } = structuredClone(input.app);
    void id;
    return { ...document, name: generatedName(input.instruction) };
  },
};
