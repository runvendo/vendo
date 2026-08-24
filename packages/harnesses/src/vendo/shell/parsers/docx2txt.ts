/**
 * `docx2txt <file>` — a Word document's text, one paragraph per line.
 *
 * A .docx is a zip with an XML part inside, so this is an unzip and a walk over
 * `<w:t>` runs — no Word, no LibreOffice, no conversion service. `fflate` does
 * the unzip (synchronous, zero dependencies); the extraction is a regex over the
 * one element that holds text, and that is deliberate: a full XML parse would
 * pull a parser in for a job whose whole grammar is "the text inside w:t,
 * grouped by w:p".
 *
 * Runs of one paragraph are JOINED, never newline-separated: Word splits a
 * sentence across runs at every formatting change, so a line per run would cut
 * "Revenue rose 26%" into three.
 */
import type { Command, LazyCommand } from "just-bash";
import { inputBytes, notThisFormat } from "./input.js";

let FFLATE_SPECIFIER = "fflate";

type Fflate = typeof import("fflate");

const NAME = "docx2txt";

/** The five XML entities a `w:t` body may carry. Nothing else is escaped in
    WordprocessingML text, so a table is the whole decoder. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};

const decode = (xml: string): string =>
  xml.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ENTITIES[entity]!);

/** The document's paragraphs, in order. */
export function paragraphsOf(documentXml: string): string[] {
  const lines: string[] = [];
  for (const paragraph of documentXml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const runs = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decode(match[1]!));
    // A paragraph with no text at all is a spacer, and a blank line between two
    // real ones is information — an empty run list is not.
    if (runs.length > 0) lines.push(runs.join(""));
  }
  return lines;
}

export const docx2txt: LazyCommand = {
  name: NAME,
  trusted: true,
  async load(): Promise<Command> {
    const { unzipSync, strFromU8 } = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ FFLATE_SPECIFIER) as Fflate;
    return {
      name: NAME,
      trusted: true,
      async execute(args, ctx) {
        const input = await inputBytes(NAME, args, ctx);
        if ("refusal" in input) return input.refusal;
        try {
          const part = unzipSync(input.bytes, { filter: (file) => file.name === "word/document.xml" })["word/document.xml"];
          if (part === undefined) throw new Error("no word/document.xml inside");
          return { stdout: `${paragraphsOf(strFromU8(part)).join("\n")}\n`, stderr: "", exitCode: 0 };
        } catch (cause) {
          return notThisFormat(NAME, args[0]!, "Word document", cause);
        }
      },
    };
  },
};
