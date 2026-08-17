---
"@vendoai/vendo": patch
"@vendoai/apps": patch
---

Three lines that promised more than the code does.

The `DataTable` spec now names the two priors a model keeps bringing to it: a column's header text is `label` — there is no `header` prop — and `paginate` is a page SIZE, so no pagination means omitting it rather than passing `false`. Both mistakes are silent from the model's side: an unknown prop is dropped at validation and `paginate={false}` never parses, so the screen simply comes back missing the thing that was asked for.

Init's closing line no longer says `vendo doctor` "can start the server and run a live turn". Doctor makes no requests at all — it validates files and wiring — so the sentence sold a check it was never going to run, and a reader who trusted it counted a green doctor as proof the app answers.

The brief stage's failure note names the artifact it already preserved. `brief stage failed (Unterminated string at position 1873) — keeping the current brief` gave nobody anything to open; it now points at `.vendo/data/extract/brief.json`, where the stage's raw output is written on the way out.
