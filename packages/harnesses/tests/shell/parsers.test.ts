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
