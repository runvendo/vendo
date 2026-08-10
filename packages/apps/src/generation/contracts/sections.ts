/**
 * The two prompt pieces that are HOST CONFIGURATION rather than engine text: the
 * theme/design-rules pair every writer must obey, and the generated COMPONENTS
 * section.
 *
 * What used to live here — the role line, the v2 tree contract, the host tool and
 * shape sections, the island contract — belonged to generation pipelines that no
 * longer exist, and so does their text; keeping it would have left a second,
 * silently diverging source of truth about a tree nothing in this package writes
 * any more.
 *
 * What survives is what a LIVE reader still asks for: `hostDesignBrief` for the
 * two writers' briefs, and `componentsPromptSection` for the shipped skill's
 * `references/format.md`.
 */
import {
  KIT_WIRE_COMPONENT_NAMES,
  kitPrompt,
} from "@vendoai/core";
import type { GenerationDependencies } from "../engine.js";

export interface GenerationPromptSection {
  id: "theme" | "design-rules";
  content: string;
}

export const composePromptSections = (sections: readonly GenerationPromptSection[]): string => sections
  .map(({ content }) => content.trim())
  .filter((content) => content.length > 0)
  .join("\n\n");

/**
 * The host's own facts, as prompt sections — shared by every actor that needs
 * them (the brain planning, the workers writing markup).
 *
 * These are the HOST'S configuration, not prompt polish: `apps.designRules` and
 * the theme tokens are documented seams a host sets and expects to be obeyed.
 * A prompt that omits them makes those config keys silently do nothing.
 */
export const hostDesignRulesSection = (deps: Pick<GenerationDependencies, "designRules">): GenerationPromptSection[] => {
  const rules = (typeof deps.designRules === "function" ? deps.designRules() : deps.designRules)?.trim();
  // The section is emitted even when the host set no rules: "(none provided)" is
  // the difference between a model that knows there are no house rules and one
  // that was never told either way.
  return [{
    id: "design-rules" as const,
    content: `HOST DESIGN RULES:\n${rules === undefined || rules === "" ? "(none provided)" : rules}`,
  }];
};

export const hostThemeSection = (deps: Pick<GenerationDependencies, "theme">): GenerationPromptSection[] =>
  deps.theme === undefined ? [] : [{
    id: "theme" as const,
    content: `THEME TOKENS:\n${JSON.stringify(deps.theme, null, 2)}`,
  }];

/**
 * The pair as ONE block, for a brief that has no section list to compose into:
 * the screen agent's, and the deployment prompt the `claudeCode()` builder
 * thinks with.
 *
 * The same two sections the fill worker reads, so the writers cannot be told
 * different things about the same host configuration.
 */
export const hostDesignBrief = (deps: Pick<GenerationDependencies, "theme" | "designRules">): string =>
  composePromptSections([...hostThemeSection(deps), ...hostDesignRulesSection(deps)]);

/** The COMPONENTS section is GENERATED from the Kit specs (kitPrompt); no
 *  hand-written component list survives here. V4 retired the legacy primitive
 *  block — one family, one generated section. Deps-independent, so it is
 *  rendered once per process (perf budget: gen-scripted:create). */
let componentsPromptCache: string | undefined;
export const componentsPromptSection = (): string => componentsPromptCache ??= `COMPONENTS (generated from the component schemas — use these EXACT component and prop names; an unknown prop is silently dropped and fails validation):

${kitPrompt({ only: [...KIT_WIRE_COMPONENT_NAMES] })}`;
