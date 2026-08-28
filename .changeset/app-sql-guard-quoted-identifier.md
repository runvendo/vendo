---
"@vendoai/apps": patch
---

**The app SQL guard's reserved names now bind an identifier, not a spelling of
one.**

The deny rules ran in the bare-identifier branch alone, so every reserved family
was admitted behind two quote characters: `query_to_xml` was refused and
`"query_to_xml"` ran. That function is `PUBLIC`-executable, takes a whole SQL
string and runs it as whoever the connection is — the host's own store role —
and `search_path` cannot fence it, because `pg_catalog` is always implicitly
searched. Every catalog name the guard knows about was reachable the same way,
which defeated the `mine.`/`shared.` boundary outright.

Quoted, unquoted, mixed case, partially quoted and `pg_catalog.`-prefixed now
refuse alike, and the refusal names the family rather than the grammar. The
quoted identifiers an app legitimately writes are untouched: a column named
`"order"`, a quoted alias, and a table name it wants case-folded all still run.
