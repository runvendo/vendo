/**
 * The component reference: the other half of the read-only `/host` mount. The
 * briefing pack names every host component in one line apiece; this answers
 * "exactly how do I write it?" — one file per catalog entry with the whole
 * description, the props schema and the entry's own examples.
 *
 * Same shape as `./skills.ts`: a PURE function of the normalized catalog,
 * recomputed per turn, so a component the host stopped registering is simply gone
 * the next turn — nothing to migrate, invalidate, or erase.
 */
import type { NormalizedCatalog, NormalizedCatalogEntry } from "./catalog.js";

/** Build contract §3.1 — beside `/host/skills`, read-only for everyone. */
export const HOST_COMPONENTS_MOUNT = "/host/components";

/**
 * A component name is a PATH SEGMENT here and a JSX-ish element name in the
 * markup, so the two agree: letters, digits and "_", starting with a letter.
 */
export const SAFE_COMPONENT_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const componentPath = (name: string): string => {
  if (!SAFE_COMPONENT_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a usable component name: it is written as an element in an app's markup and as a file under ${HOST_COMPONENTS_MOUNT}, so it may only use letters, digits and "_", starting with a letter, up to 64 characters.`,
    );
  }
  return `${HOST_COMPONENTS_MOUNT}/${name}.md`;
};

/** One entry as its reference file. Sections are omitted rather than left empty:
 *  a heading with nothing under it reads as a gap in the component. */
const renderComponentMd = (entry: NormalizedCatalogEntry): string => {
  const sections = [`# ${entry.name}`, entry.description.trim()];
  sections.push(
    entry.propsJsonSchema === undefined
      ? "## Props\n\nThis component declares no props schema. Follow its description and examples, and keep props to what they show."
      : `## Props\n\n\`\`\`json\n${JSON.stringify(entry.propsJsonSchema, null, 2)}\n\`\`\``,
  );
  if (entry.examples !== undefined && entry.examples.length > 0) {
    sections.push(`## Examples\n\n${entry.examples.map((example) => `\`\`\`\n${example}\n\`\`\``).join("\n\n")}`);
  }
  return `${sections.join("\n\n")}\n`;
};

/**
 * The catalog as the `/host/components` half of the host projection: path →
 * markdown, ready to hand to the workspace open call beside `hostSkillFiles`.
 */
export const hostComponentFiles = (catalog: NormalizedCatalog): Record<string, string> =>
  Object.fromEntries(catalog.map((entry) => [componentPath(entry.name), renderComponentMd(entry)]));
