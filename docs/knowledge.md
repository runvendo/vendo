# Knowledge

Connect your product knowledge and the embedded agent answers from it —
grounded, cited, and honest when the evidence is weak. One frozen contract
(`KnowledgeAdapter` in `@vendoai/core`), one developer door (`vendo
knowledge` — docs-as-code sync from your repo), and three OSS engines behind
the same contract:

| Engine | What it is | Posture |
| --- | --- | --- |
| `vendoKnowledge()` | Free tier: keyword retrieval in your own store — works offline, zero keys | full (`fetch`, `write`, `visibility: "enforced"`) |
| `cloudKnowledge({ apiKey })` | Vendo Cloud's managed engine over `vendo/knowledge-wire@1` — composed for you from `VENDO_API_KEY` | full |
| `httpKnowledge({ url })` | BYO: any endpoint you run, in any language, speaking the same wire | declared — partial implementations are first-class |

## Quickstart: config → sync → agent answers

Register local sources (globs of markdown/JSON files) with an explicit
content kind and visibility tier:

```sh
vendo knowledge add "docs/**/*.md"                       # kind docs, public (defaults)
vendo knowledge add "glossary.md" --kind glossary
vendo knowledge add "internal/**/*.md" --visibility internal
vendo knowledge list
```

That writes `.vendo/knowledge.json` (`vendo/knowledge@1`, strict schema —
unknown keys fail loudly). Kinds shape retrieval: `docs` is prose chunked at
heading boundaries; `glossary` and `api` files become one document per term
(markdown headings, or JSON `{ "term": "definition" }` / `[{ term,
definition }]`), which is what makes exact `schema`-intent lookups honest.
`internal` documents surface only to trusted host-wired callers
(`includeInternal`), never to end users.

Then move content:

```sh
vendo knowledge sync --dry-run   # print the plan
vendo knowledge sync             # ingest → diff → push changed docs
```

`sync` is the only verb that moves content. It parses and chunks your files,
diffs against the sha256 hash manifest (`.vendo/knowledge-manifest.json` —
regenerable, add it to `.gitignore`), upserts exactly the documents that
changed, removes the ones that vanished, and rewrites the manifest last. With
no engine configured it targets the local lexical engine over the project's
default store (`.vendo/data` — the dev server's ENG-351 single-writer lock
applies, so stop the dev server first or point the engines at your own
Postgres). Re-running with no changes pushes nothing.

The agent side needs no wiring beyond the knowledge slot on `createVendo`:
`knowledge: vendoKnowledge()` — the composed store is injected for you, and
the agent's `vendo_knowledge_search` tool retrieves snippets, fetches
read-more context, and cites documents or refuses when evidence is weak.

## Which engine you get

Which engine backs the tool is the standard adapter decision, made once in
`createVendo`:

1. An explicit `knowledge: <adapter>` always wins — including the keyless BYO
   engines (`vendoKnowledge()`, `httpKnowledge({ url })`). A Cloud
   subscriber therefore keeps its own engine by construction: a key never
   shadows a slot you filled.
2. `VENDO_API_KEY` fills the slot with the Vendo Cloud engine (`cloudKnowledge`
   against the console mount; `VENDO_CLOUD_URL` overrides the base URL). No
   other wiring — a key is the whole setup.
3. Nothing set: no adapter, and `vendo_knowledge_search` does not exist. The
   agent never advertises a knowledge base you don't have.

Rung 3 is the only quiet outcome. A key that is wrong, or a console that is
down, is not: like every Vendo Cloud seam, key problems surface on the first
real call rather than at a validate endpoint — the tool answers `unavailable`
(the agent says it cannot check the docs; it never reports an empty corpus as
"nothing found"), and the server log carries the actual cause, once per
distinct failure.

## The verifier pass (Cloud engine)

Retrieval scores are a weak signal for "do I actually know this?". Measured
against our own docs, the Cloud engine scores questions it *can* answer and
questions it *cannot* in the same range: at the best possible score bar, 47%
of unanswerable questions still cleared it. No bar fixes that — it is a
property of embedding similarity, which cannot tell "how to install in a
framework" from "how to install in **your** framework".

So there is an opt-in check on the Cloud engine. Turn it on with
`VENDO_KNOWLEDGE_VERIFY=on` and, before the tool returns, a cheap model reads
the passages the search actually returned and answers one question: can this
question be answered from these alone? If not, the tool returns its ordinary
`insufficient-evidence` outcome — carrying the gap the verifier named, so the
agent can say *what* the docs do not cover — and the agent says it does not
know. Same tool, same outcomes, same UI.

The check is **not** gated on the retrieval score. An earlier version ran it
only inside the score band where the bar was provably useless, and the live run
showed the cost: four unanswerable questions per pass scored outside that band,
were never checked, and were answered. A check gated on the number it exists to
replace inherits that number's blind spots.

Measured live against Agentset over the 94-question corpus: see
[the table](eval/KNOWLEDGE.md#the-verifier-pass) for per-pass numbers, the
worst case, added latency and per-search cost.

Five properties are worth knowing:

- **It is OFF by default, and `on` is one variable.** It ships off because the
  live measurement says it does not deliver the thing it exists for: with the
  check on, the corpus still answered a quarter to a half of its unanswerable
  questions, while costing a model call per search and seconds of latency on a
  call your user is waiting through. That is a trade to opt into with your eyes
  open, not a default. Anything that is neither `on` nor `off` fails loudly at
  startup rather than leaving you with a trust feature you think is running.
- **Turning it on changes no threshold.** Your `weakScoreThreshold` is exactly
  what you set it to; every search the check cannot read (no model, timeout,
  unusable answer) is decided by that threshold as before. When there IS a
  verdict the verdict decides, in both directions: it refuses evidence the
  score liked, and answers evidence the score did not.
- **It only applies to the Cloud engine.** Scores are engine-relative, so a
  number calibrated on one engine means nothing on another. Local lexical, BYO
  and self-hosted engines are untouched.
- **It can never take knowledge away — and it says when it could not check.**
  No model credential, a timeout past 5s, or an unusable response means *no
  verdict*: the tool answers exactly as it would have without a verifier, and
  flags the result `unverified`. The thread renders that as the amber "I
  couldn't check this answer against the documentation" line beside the
  sources, so a check that did not run never looks like one that passed.
  Verification is capped per turn as well as per call, so a chat→deep
  escalation cannot spend the cap twice.
- **It has its own model slot.** `knowledgeVerifier` sits beside `judge`: pin
  it with `VENDO_MODEL_KNOWLEDGE_VERIFIER` or `models.knowledgeVerifier`, and
  the model that grades your answers stays independent of the one that gates
  them. It defaults to your provider's cheap/fast model.

## Engines

**Local lexical** — honest keyword grade: deterministic term-frequency
ranking with title/heading boosts over the `vendo_knowledge_docs` /
`vendo_knowledge_chunks` collections in your store. A query matching nothing
returns zero hits (the agent says it doesn't know), `deep` intent is
documented as no-op escalation locally, and `schema` intent is exact
term/title lookup over glossary/api entries. Pass
`vendoKnowledge({ store })` to keep the knowledge tables in a different
database.

**Cloud** — `cloudKnowledge({ apiKey })` speaks `vendo/knowledge-wire@1`
against the console mount. You rarely construct it: `VENDO_API_KEY` composes
it for you (see [Which engine you get](#which-engine-you-get)); pass it
explicitly only to point one composition at a different key or console.
Tenancy never crosses the wire: your corpus is the key's org, resolved
server-side. Managed acquisition (crawl a docs URL, Notion/Drive) is connected
in the console — `vendo knowledge add notion` prints the deep link.

**BYO HTTP** — see [BYO knowledge wire](knowledge-wire-byo.md). Search-only
endpoints are legal: declare the posture and the rest of the contract adapts
(`vendo knowledge sync` refuses loudly to push to a read-only engine).

All three run the same conformance suite
(`knowledgeAdapterConformance` from `@vendoai/core/conformance`) — "behind
the same contract" is enforced in CI, not promised.
