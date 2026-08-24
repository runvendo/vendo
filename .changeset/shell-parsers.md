---
"@vendoai/harnesses": minor
---

The shell can open the formats people actually send.

`pdftotext`, `xlsx2csv` and `docx2txt` are now commands inside the agent's shell.
They write text to stdout, so they pipe into `grep`, `awk` and everything else —
`pdftotext invoice.pdf | grep -o 'Total.*'` is one call, not a capability
conversation. A PDF, a spreadsheet or a Word document dropped into chat stops
being a file the agent can only name.

They run in the host process against the same virtual filesystem the shell has
(unpdf's serverless pdf.js, SheetJS Community Edition, and a zip read with
fflate — no native code, no conversion service, no network), and each library
loads the first time its format is actually parsed, so a deployment that never
sees a PDF never pays for pdf.js.
