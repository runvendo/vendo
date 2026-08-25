/**
 * `xlsx2csv <file> [sheet]` — one sheet of a workbook, as CSV on stdout.
 *
 * CSV and not JSON because the rest of the shell speaks CSV: once it is on
 * stdout, `cut`, `awk`, `sort` and `jq -R` all work on it, which is the whole
 * reason the parsers are COMMANDS and not tools of their own.
 *
 * SheetJS Community Edition, pure JavaScript, synchronous, no native code.
 */
import type { Command, LazyCommand } from "just-bash";
import { importShellLibrary } from "../runtime.js";
import { inputBytes, notThisFormat } from "./input.js";

/** `@e965/xlsx` is SheetJS CE republished on the public registry. SheetJS
    itself ships only from its own CDN, and pnpm 11 (blockExoticSubdeps)
    refuses a URL-resolved dependency reached through a dependency, so the CDN
    tarball breaks every pnpm consumer; npm's stale `xlsx@0.18.5` carries
    CVE-2023-30533 and CVE-2024-22363, both in this read path. The mirror is
    one individual's account, so the EXACT pin is the control — npm forbids
    replacing a published version, so a consumer can only get bytes we checked.
    Re-verify on any bump (empty diff == identical to the official tarball):
      diff <(curl -sL https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz \
        | tar xzO package/xlsx.js) node_modules/@e965/xlsx/xlsx.js */
type SheetJs = typeof import("@e965/xlsx");

const NAME = "xlsx2csv";

/** SheetJS never refuses. Handed bytes it does not recognise it falls back to
    plain-text sniffing and hands back a one-cell "workbook", so `xlsx2csv
    notes.txt` would exit 0 on nonsense — verified against 0.20.3, which even
    accepts four random bytes. The gate is therefore ours, and it is the
    container magic: every BINARY workbook SheetJS reads is a zip (xlsx, xlsb,
    ods) or an OLE compound file (xls). The text formats it can also guess at
    (csv, prn, sylk) are already the rest of the shell's job. */
const WORKBOOK_MAGIC = [
  [0x50, 0x4b], // "PK" — zip
  [0xd0, 0xcf, 0x11, 0xe0], // OLE compound file
];

const isWorkbook = (bytes: Uint8Array): boolean =>
  WORKBOOK_MAGIC.some((magic) => magic.every((byte, index) => bytes[index] === byte));

export const xlsx2csv: LazyCommand = {
  name: NAME,
  trusted: true,
  async load(): Promise<Command> {
    const XLSX = await importShellLibrary<SheetJs>("@e965/xlsx");
    return {
      name: NAME,
      trusted: true,
      async execute(args, ctx) {
        const input = await inputBytes(NAME, args, ctx);
        if ("refusal" in input) return input.refusal;
        if (!isWorkbook(input.bytes)) {
          return notThisFormat(NAME, args[0]!, "spreadsheet", "not a zip or OLE workbook container");
        }
        let book: ReturnType<SheetJs["read"]>;
        try {
          book = XLSX.read(input.bytes, { type: "array" });
        } catch (cause) {
          return notThisFormat(NAME, args[0]!, "spreadsheet", cause);
        }
        const wanted = args[1] ?? book.SheetNames[0];
        // SheetNames, not a bare `Sheets[wanted]`: `xlsx2csv book.xlsx toString`
        // would otherwise find Object.prototype's method and print an empty CSV
        // with exit 0 instead of naming the sheets.
        const sheet = wanted !== undefined && book.SheetNames.includes(wanted)
          ? book.Sheets[wanted]
          : undefined;
        if (sheet === undefined) {
          // Naming the sheets IS the fix: an agent told only "no" asks the user,
          // an agent told what exists picks the right one and carries on.
          return {
            stdout: "",
            stderr: `${NAME}: ${args[0]}: no sheet named ${JSON.stringify(wanted)};`
              + ` this workbook has ${book.SheetNames.join(", ")}\n`,
            exitCode: 1,
          };
        }
        // Terminated, like the other parsers and like every text stream a shell
        // produces: `sheet_to_csv` stops after the last row, and an unterminated
        // last line makes `wc -l` and `tail` undercount the sheet by one.
        return { stdout: `${XLSX.utils.sheet_to_csv(sheet)}\n`, stderr: "", exitCode: 0 };
      },
    };
  },
};
