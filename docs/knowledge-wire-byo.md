# BYO knowledge wire (`vendo/knowledge-wire@1`)

Any endpoint you run — any language, any retrieval stack — is a first-class
knowledge engine once it speaks the five wire routes. The wire is the HTTP
profile of core's frozen `KnowledgeAdapter` contract, spoken identically by
`cloudKnowledge` and your endpoint; schemas live in `@vendoai/core`
(`knowledge-wire.ts`) and the **reference server implementation is the fake
in `packages/knowledge/src/cloud.test-util.ts`** — one fetch handler,
wire-schema-validated, that the conformance suite runs against. Copy its
shape.

## Point Vendo at it

```ts
import { httpKnowledge } from "@vendoai/knowledge";

const knowledge = httpKnowledge({
  url: "https://internal.example.com/knowledge",
  auth: { bearer: process.env.KNOWLEDGE_TOKEN },
  posture: { fetch: true },        // declare exactly what you implement
});
```

The default posture is the least an endpoint can promise: `{ fetch: false,
write: false, visibility: "public-only" }` — search + status only. Partial
implementations are first-class: without `fetch` the agent's read-more is
gracefully absent; without `write`, `vendo knowledge sync` refuses loudly to
push (manage that corpus at its source). `visibility: "public-only"` is your
attestation that the corpus carries no internal-tier content.

## The five routes

Mounted under your `url`; the four operations are POST-JSON, `status` is GET.
Request/response bodies must validate against the schemas in
`@vendoai/core`:

| Route | Body | 200 response |
| --- | --- | --- |
| `POST /search` | `{ query: KnowledgeQuery, includeInternal? }` | `KnowledgeSearchResult` — hits most-relevant-first |
| `POST /fetch` | `{ ref: KnowledgeRef, includeInternal? }` | `KnowledgeFetchResult`; missing/invisible ref → the enveloped `not-found`, 404 |
| `POST /upsert` | `{ docs: KnowledgeDoc[] }` | `{}` — **only after the docs are searchable** |
| `POST /remove` | `{ docIds: string[] }` | `{}`; unknown ids are no-ops |
| `GET /status` | — | `{ format: "vendo/knowledge-wire@1", posture, status }` — the discovery handshake |

Rules that make clients behave correctly against you:

- **Errors are envelopes**: `{ error: { code, message } }` with the status
  from `KNOWLEDGE_WIRE_STATUS_BY_CODE` (`knowledgeWireErrorBody` builds
  both). A bare 404 with no envelope reads as a broken mount, never as an
  absent document.
- **Undeclared routes answer `not-implemented`, 501** — never a bare 404.
- **Invalid bodies answer `validation`, 400** (validate with the wire
  request schemas).
- **No tenant selector ever crosses the wire.** Auth is yours (the `bearer`
  option arrives as `Authorization: Bearer …`); derive any tenancy
  server-side from it.
- Scores are engine-relative — rank order is the contract, absolute values
  are not comparable across engines.

## Prove it conforms

Run the same suite the built-in engines pass, posture-adapted, from your own
tests:

```ts
import { knowledgeAdapterConformance, runConformance } from "@vendoai/core/conformance";

const report = await runConformance(knowledgeAdapterConformance({
  makeAdapter: async () => ({ adapter: httpKnowledge({ url, posture }) }),
  posture,
  seedDocs,   // read-only endpoints come pre-seeded — you control the corpus
}));
```
