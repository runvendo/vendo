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
import { importShellLibrary } from "../runtime.js";
import { inputBytes, notThisFormat } from "./input.js";

type Fflate = typeof import("fflate");

const NAME = "docx2txt";

/** What `word/document.xml` may inflate to. The upload cap bounds the FILE, and
 *  a zip's ratio is unbounded: 150 KB of deflated zeros — comfortably under it —
 *  carries 51 MB, and this shell runs in the host process, so that is the host's
 *  memory. fflate inflates to the size the archive DECLARES, which makes the
 *  declared size a sound gate and a free one: nothing is decompressed to learn
 *  it. 32 MB matches what the session's whole `/tmp` may hold, so no document a
 *  person can actually upload comes near it. */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** The five named XML entities. Numeric references are legal in any XML and
    plenty of .docx writers emit them, so they decode here too — left alone they
    reach the agent as a literal `&#8212;`. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
};

const decode = (xml: string): string =>
  xml.replace(/&(?:#(\d+)|#[xX]([\dA-Fa-f]+)|amp|lt|gt|quot|apos);/g, (entity, decimal, hex) => {
    if (decimal === undefined && hex === undefined) return ENTITIES[entity]!;
    const code = decimal === undefined ? parseInt(hex, 16) : Number(decimal);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });

/** Every tag that carries text, matched ONE AT A TIME. Matching `<w:t>…</w:t>`
    as a single lazy pair is the trap: against openers that never close, each one
    rescans to the end of the paragraph, so a malformed part costs O(n²) of
    blocked event loop. Each alternative here stops at the next `<` OR its own
    `>`, so the scan is linear no matter what the bytes say — `[^>]*` alone is
    not enough, because an opener whose `>` never arrives then scans to the end
    of the part for EVERY opener, which is the same O(n²) one level deeper. `<`
    cannot appear inside a tag in any well-formed XML (it is `&lt;` there), so
    excluding it costs no real document a thing.

    `<w:tab/>` is EMPTY: a tab STOP is a `w:tab` in `w:pPr` carrying `w:val`, so
    demanding the self-closing form keeps stops out of the text. */
const CONTENT =
  /(?<open><w:t(?:\s[^<>]*)?>)|(?<shut><\/w:t>)|(?<tab><w:tab\s*\/>)|<w:(?:br|cr)\b[^<>]*>/g;

/** What one paragraph contributes, in document order. */
function runsOf(paragraph: string): string[] {
  const runs: string[] = [];
  let textFrom = -1;
  for (const match of paragraph.matchAll(CONTENT)) {
    const { open, shut, tab } = match.groups!;
    if (open !== undefined) textFrom = match.index! + open.length;
    else if (shut === undefined) runs.push(tab === undefined ? "\n" : "\t");
    else {
      if (textFrom !== -1) runs.push(decode(paragraph.slice(textFrom, match.index!)));
      textFrom = -1;
    }
  }
  return runs;
}

/** The document's paragraphs, in order. */
export function paragraphsOf(documentXml: string): string[] {
  const lines: string[] = [];
  // SPLIT on the opener rather than matching `<w:p …>…</w:p>` lazily, for the
  // same reason {@link CONTENT} matches one tag at a time.
  for (const chunk of documentXml.split(/<w:p[ >]/).slice(1)) {
    const close = chunk.indexOf("</w:p>");
    const runs = runsOf(close === -1 ? chunk : chunk.slice(0, close));
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
    const { unzipSync, strFromU8 } = await importShellLibrary<Fflate>("fflate");
    return {
      name: NAME,
      trusted: true,
      async execute(args, ctx) {
        const input = await inputBytes(NAME, args, ctx);
        if ("refusal" in input) return input.refusal;
        try {
          const part = unzipSync(input.bytes, {
            filter: (file) => {
              if (file.name !== "word/document.xml") return false;
              if (file.originalSize > MAX_DOCUMENT_BYTES) {
                throw new Error(`word/document.xml declares ${file.originalSize} bytes`);
              }
              return true;
            },
          })["word/document.xml"];
          if (part === undefined) throw new Error("no word/document.xml inside");
          return { stdout: `${paragraphsOf(strFromU8(part)).join("\n")}\n`, stderr: "", exitCode: 0 };
        } catch (cause) {
          return notThisFormat(NAME, args[0]!, "Word document", cause);
        }
      },
    };
  },
};
