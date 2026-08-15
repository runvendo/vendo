/**
 * The one prompt piece that is HOST CONFIGURATION rather than engine text: the
 * generated COMPONENTS section.
 *
 * What used to live here — the role line, the v2 tree contract, the host tool and
 * shape sections, the island contract — belonged to generation pipelines that no
 * longer exist, and so does their text; keeping it would have left a second,
 * silently diverging source of truth about a tree nothing in this package writes
 * any more.
 *
 * The theme/design-rules pair left with it: what a writer is told about this
 * host is now ONE assembly, `contract/briefing.ts`'s `renderBriefingPack`, and
 * a second rendering of the same two config keys is exactly what that file
 * exists to prevent.
 *
 * What survives is what a LIVE reader still asks for: `componentsPromptSection`
 * for the shipped skill's `references/format.md`.
 */
import {
  KIT_SCREEN_COMPONENT_NAMES,
  kitPrompt,
} from "../../../contract/index.js";

/** The COMPONENTS section is GENERATED from the Kit specs (kitPrompt); no
 *  hand-written component list survives here. V4 retired the legacy primitive
 *  block — one family, one generated section. Deps-independent, so it is
 *  rendered once per process (perf budget: gen-scripted:create). */
let componentsPromptCache: string | undefined;
export const componentsPromptSection = (): string => componentsPromptCache ??= `COMPONENTS (generated from the component schemas — use these EXACT component and prop names; an unknown prop is silently dropped and fails validation):

${kitPrompt({ only: [...KIT_SCREEN_COMPONENT_NAMES] })}`;
