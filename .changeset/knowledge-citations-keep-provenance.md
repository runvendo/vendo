---
"@vendoai/knowledge": patch
---

Knowledge citations keep their provenance on the main search path, and both
shipped wire engines are one client.

The built-in local engine denormalized `kind`, `visibility` and `title` from
the doc into each chunk row but not `source`, so the chat/deep ref shape had no
`source` while the schema-intent and `fetch` shapes did. Since `toCitation`
forwards `source` only when it is present, every citation an agent produced on
the default retrieval path silently lost the file or URL the text came from —
only glossary lookups and the cloud engine carried it. `source` is now
denormalized alongside `title` at upsert time and rides the hit ref, so all
three intents return the same ref shape.

Existing stores get this without a re-sync. Chunk rows written by earlier
versions have no `source` field, and `vendo knowledge sync` skips documents
whose content hash is unchanged, so those rows would never be rewritten —
search reads through to the document row for them instead. Nothing to run, no
migration, and the doc row has always carried `source`.

`cloudKnowledge` and `httpKnowledge` were the same `vendo/knowledge-wire@1`
client written out twice: identical transport, identical response parsing,
identical `includeInternal` handling, identical route bodies. Only the base
path, whether the bearer is mandatory, the posture, and the wording of the
client's own errors ever differed. They now share one internal client that
takes those four as arguments, so a retry, header, timeout or status mapping is
added in one place instead of two that can drift. No behaviour changes for
either engine.

`toCitation` is no longer exported from the package barrel. It is the tool's
own hit-to-citation mapper, it had no importer anywhere, and the citation shape
it produces is already public as `KnowledgeCitation`.
