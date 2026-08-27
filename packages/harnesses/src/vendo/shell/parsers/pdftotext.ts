/**
 * `pdftotext <file>` — a PDF's text, on stdout.
 *
 * LAZY on purpose: unpdf carries a serverless build of pdf.js (~1.6 MB) and most
 * turns never touch a PDF, so it loads the first time one is actually parsed and
 * never again. TRUSTED, because it runs in the HOST process against the same
 * virtual filesystem the shell has — it is our code reading our bytes, not
 * user JavaScript.
 *
 * Only stdout, deliberately: real `pdftotext` writes `<name>.txt` by default, and
 * a command that silently creates a file is a command that surprises an agent
 * mid-pipeline. Redirect it if you want a file.
 */
import type { Command, LazyCommand } from "just-bash";
import { importShellLibrary } from "../runtime.js";
import { inputBytes, notThisFormat } from "./input.js";

type Unpdf = typeof import("unpdf");

const NAME = "pdftotext";

export const pdftotext: LazyCommand = {
  name: NAME,
  trusted: true,
  async load(): Promise<Command> {
    const { extractText } = await importShellLibrary<Unpdf>("unpdf");
    return {
      name: NAME,
      trusted: true,
      async execute(args, ctx) {
        const input = await inputBytes(NAME, args, ctx);
        if ("refusal" in input) return input.refusal;
        try {
          // Page by page, joined with the form feed real `pdftotext` uses, so
          // "what is on page 3" is answerable with `awk` instead of guesswork.
          const { text } = await extractText(input.bytes, { mergePages: false });
          return { stdout: `${text.join("\n\f\n")}\n`, stderr: "", exitCode: 0 };
        } catch (cause) {
          return notThisFormat(NAME, args[0]!, "PDF", cause);
        }
      },
    };
  },
};
