/**
 * The three parsers, each against a REAL file of its format built right here.
 * A fixture you can read is a fixture you can debug, and the libraries under
 * test (pdf.js via unpdf, SheetJS, a zip) will not accept a fake.
 */
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createShellSession } from "../../src/vendo/shell/engine.js";

/** A structurally valid one-page PDF with one line of Helvetica text. The xref
    offsets are computed, not typed, so the file is always well-formed. */
function minimalPdf(line: string): Uint8Array {
  const stream = `BT /F1 12 Tf 20 100 Td (${line}) Tj ET`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

async function diskWith(files: Record<string, Uint8Array | string>): Promise<IFileSystem> {
  const fs = new InMemoryFs();
  for (const [path, content] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await fs.writeFile(path, content);
  }
  return fs as unknown as IFileSystem;
}

describe("pdftotext", () => {
  it("reads the text out of a real PDF", async () => {
    const workspace = await diskWith({ "/user/files/invoice.pdf": minimalPdf("Invoice 4210 total 980.00") });
    const session = createShellSession({ workspace });

    const result = await session.exec("pdftotext files/invoice.pdf");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Invoice 4210 total 980.00");
  });

  it("pipes, like every other command in the shell", async () => {
    const workspace = await diskWith({ "/user/files/invoice.pdf": minimalPdf("Invoice 4210 total 980.00") });
    const session = createShellSession({ workspace });

    const result = await session.exec("pdftotext files/invoice.pdf | grep -o '4210'");

    expect(result.stdout.trim()).toBe("4210");
  });

  it("says so when the file is not a PDF", async () => {
    const workspace = await diskWith({ "/user/files/notes.txt": "just words\n" });
    const session = createShellSession({ workspace });

    const result = await session.exec("pdftotext files/notes.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a readable PDF");
  });

  it("says so when there is no file", async () => {
    const session = createShellSession({ workspace: await diskWith({}) });

    const result = await session.exec("pdftotext files/missing.pdf");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file or directory");
  });
});

describe("xlsx2csv", () => {
  /** A real workbook, written by the same library that will read it back. */
  const workbook = async (): Promise<Uint8Array> => {
    const XLSX = await import("@e965/xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["month", "revenue"], ["jan", 31000], ["feb", 39000]]),
      "Revenue",
    );
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["note"], ["draft"]]), "Notes");
    return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  };

  it("turns the first sheet into CSV on stdout", async () => {
    const session = createShellSession({ workspace: await diskWith({ "/user/files/q1.xlsx": await workbook() }) });

    const result = await session.exec("xlsx2csv files/q1.xlsx");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["month,revenue", "jan,31000", "feb,39000"]);
  });

  it("takes a sheet by name, and lists them when the name is wrong", async () => {
    const session = createShellSession({ workspace: await diskWith({ "/user/files/q1.xlsx": await workbook() }) });

    expect((await session.exec("xlsx2csv files/q1.xlsx Notes")).stdout.trim().split("\n"))
      .toEqual(["note", "draft"]);

    const wrong = await session.exec("xlsx2csv files/q1.xlsx Nope");
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain("Revenue");
    expect(wrong.stderr).toContain("Notes");
  });

  it("says so when the file is not a workbook", async () => {
    const session = createShellSession({ workspace: await diskWith({ "/user/files/notes.txt": "just words\n" }) });

    const result = await session.exec("xlsx2csv files/notes.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a readable spreadsheet");
  });
});

describe("docx2txt", () => {
  /** A real .docx: a zip carrying the three parts Word requires. */
  const document = async (paragraphs: string[]): Promise<Uint8Array> => {
    const { zipSync, strToU8 } = await import("fflate");
    const body = paragraphs
      .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
      .join("");
    return zipSync({
      "[Content_Types].xml":
        strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
      "_rels/.rels":
        strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
      "word/document.xml":
        strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    });
  };

  it("reads the paragraphs out of a real .docx, one per line", async () => {
    const workspace = await diskWith({
      "/user/files/brief.docx": await document(["Quarterly brief", "Revenue rose 26% to 98,000."]),
    });
    const session = createShellSession({ workspace });

    const result = await session.exec("docx2txt files/brief.docx");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Quarterly brief\nRevenue rose 26% to 98,000.\n");
  });

  it("keeps a paragraph whole when Word split it into runs", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const split = zipSync({
      "word/document.xml": strToU8(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
        + `<w:p><w:r><w:t xml:space="preserve">Revenue rose </w:t></w:r><w:r><w:t>26%</w:t></w:r></w:p>`
        + `</w:body></w:document>`,
      ),
    });
    const session = createShellSession({ workspace: await diskWith({ "/user/files/split.docx": split }) });

    expect((await session.exec("docx2txt files/split.docx")).stdout).toBe("Revenue rose 26%\n");
  });

  it("says so when the file is not a .docx", async () => {
    const session = createShellSession({ workspace: await diskWith({ "/user/files/notes.txt": "just words\n" }) });

    const result = await session.exec("docx2txt files/notes.txt");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a readable Word document");
  });
});
