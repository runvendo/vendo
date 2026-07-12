# Compact encoding spike — design & findings

**Status: SPIKE. Nothing here is shipped or registered.** This directory tests
whether the app-format spec §7 "token-compact wire profile" (named-now,
designed-later — see `docs/contracts/01-core.md` §8) actually pays off for the
pinned `vendo-genui/v1` tree. The pinned wire format is untouched; no new format
is registered in `@vendoai/core`. Output is evidence + a recommendation.

The Monogram research motivating the spike: fast GenUI players stream
schema-constrained UI-as-data, compact UI DSLs cut ~65% of output tokens, and
latency is roughly linear in output tokens. The question this spike answers: does
that hold for **our** tree?

**Headline: partly.** A compact profile is straightforward and provably lossless
(within a loudly-enforced extension-field boundary, §4), but the token savings on
real trees are **~26–33%**, not ~65% — the byte savings are larger (~39–44%) but
the Claude tokenizer already compresses JSON's repeated punctuation and keys, so
bytes don't convert 1:1 to tokens. And the recommendation turns not on the
savings but on **who emits the format** (§6, §9).

---

## 1. What the tree is, and why it shapes the design

A `vendo-genui/v1` tree is a **flat array of nodes** (`id`, `component`,
`source?`, `props?`, `children?`) plus optional `data`, `queries`, and a
`components` map. Edges are child-**id references**, not nesting. That flat array
is really a **graph**: children can be shared (a DAG — `resolve.test.ts` has one
node with two parents), cyclic (`a→b→a`), dangling (a child id with no node —
renders as a streaming skeleton), or orphaned (a node no one references).

This kills the obvious "aggressive" idea — an **indentation-nests-children DSL**,
the shape the Monogram research credits with the biggest savings. Nesting cannot
represent a DAG/cycle/orphan without either duplicating shared subtrees (lossy) or
inventing a by-id reference syntax (no simpler than the ids we already have). So
the aggressive candidate here (VTL) stays **flat and id-referenced**; its savings
come from dropping keys/braces/quotes, not from nesting. **This is itself a
finding:** the highest-savings DSL shape in the literature is structurally
incompatible with our format.

Both candidates are also constrained to be losslessly and mechanically
convertible to/from the readable tree: every binding (`{$path}` / `{$state}`),
action, `fn:` reference, query, `components` entry, and dangling child must
survive.

---

## 2. Candidate A — CJT ("Compact JSON Tree"), the conservative profile

Same JSON container, three redundancies removed: single-char keys; a
component-name **intern table** (`k`) referenced by index; **positional node
tuples** with trailing-absent fields dropped; the `source` enum as a small int
(0=absent, 1/2/3 = prewired/host/generated).

## 3. Candidate B — VTL ("Vendo Tree Lines"), the aggressive profile

One line per thing, a one-char opcode, structural punctuation stripped to almost
nothing. Flat (not nesting, per §1). A literal TAB separates a node's head from
its props-JSON from its child-id list — and a TAB can never appear inside a
minified-JSON string (JSON escapes it), so tab-splitting is collision-free and
arbitrary/unicode/escaping-hostile prop **values** cost zero extra escaping (JSON
already owns their quoting).

**Tokens cover the full legal range** (review round 2): `validateTree` allows ids
and component names containing whitespace, quotes, or sigil-leading characters
(and child ids may even be empty strings), so raw emission alone cannot cover
the format. A VTL token is either RAW (non-empty, no space/tab/newline, doesn't
start with `"`) or ESCAPED (a JSON string literal with literal spaces further
escaped as ` `, so an escaped token carries no structural whitespace at
all). A sourceless component whose name starts with a sigil character is
force-escaped — a component literally named `.Foo` therefore round-trips instead
of misdecoding as prewired `Foo`. Every validateTree-legal id/component/source
combination round-trips; the property Arbitrary generates hostile ids/components
(spaces, tabs, newlines, leading `"`/`.`/`:`/`*`, unicode, empty child ids) to
police exactly this. Ordinary trees pay nothing: identifier-shaped tokens emit
raw, so the escaping machinery is invisible on every fixture and every
model-emitted tree measured below (encoded sizes were re-verified byte-identical
after this change).

### Side by side (the `dag-shared` fixture)

Readable, minified (the honest wire baseline):

```json
{"formatVersion":"vendo-genui/v1","root":"root","nodes":[{"id":"root","component":"Stack","children":["x","y"]},{"id":"x","component":"Stack","children":["shared"]},{"id":"y","component":"Stack","children":["shared"]},{"id":"shared","component":"Text"}]}
```

CJT:

```json
{"f":"vendo-cjt/1","r":"root","k":["Stack","Text"],"n":[["root",0,0,0,["x","y"]],["x",0,0,0,["shared"]],["y",0,0,0,["shared"]],["shared",1]]}
```

VTL (four node lines; `shared` is one node referenced by both `x` and `y` — the
DAG survives because VTL is flat):

```
vtl1 root
-root Stack		x y
-x Stack		shared
-y Stack		shared
-shared Text
```

Note the CJT tuples carry explicit `0,0` placeholders for absent `source`/`props`
whenever `children` is present (positional encoding can't skip a middle slot) —
VTL avoids that with its tab structure, which is most of VTL's edge over CJT.

---

## 4. Lossless round-trip guarantee + canonicalization

Both profiles satisfy, as a fast-check property over the format's range
(`src/roundtrip.test.ts`, 200 runs):

> `decode(encode(t))` deep-equals `canonicalize(t)`, and the result re-passes
> `@vendoai/core.validateTree`.

`canonicalize` (`src/canonicalize.ts`) is defined explicitly so "equal" is
precise. It (1) rejects anything `validateTree` rejects, (2) **rejects — loudly,
never silently — unknown extension fields**, (3) omits `undefined` optionals, and
(4) normalizes an **empty** top-level `queries: []` / `components: {}` to absent
— the one value-level normalization, justified because an empty collection
carries no information (identical to a consumer) and a line-oriented profile
represents these collections by the presence of their lines. Everything else is
preserved with no normalization: **node array order** (the array is a set keyed
by unique id; render order is root+children-driven, and both profiles emit and
restore input order, so nothing needs reordering), children order, DAG/cyclic
/dangling references, object contents and unicode, and present-but-empty
`props:{}` / `children:[]` on a node (kept distinct from absent).

**The extension-field boundary, stated plainly** (review round 2): `validateTree`
is *passthrough* at the tree, node, and query levels — it accepts documents
carrying keys outside the contract. Neither compact profile encodes such keys,
so "lossless vs canonicalize(t)" would have been quietly weaker than "lossless
vs everything validateTree accepts" if extension fields were silently dropped.
The spike chooses loud rejection instead: `canonicalize` — and therefore both
`encode()`s, which call it first — **throws** on any key outside the contract's
field set at those three levels (`props`/`data`/`components` *contents* are
data, not extension fields, and pass through untouched). Consequence for a real
adoption: a compact profile is an encoding of the *contract's* field set; a
future contract field would extend the profile in the same release, and a
document carrying unknown keys must stay on the readable format. Round-trip
losslessness is claimed for exactly the contract-shaped range, and the encoders
make that boundary impossible to cross silently.

**Strict decoders** (review round 2): both decoders are the validity oracle for
the live emission measurement (§6), so they reject anything off-grammar rather
than salvage it — CJT: wrong/unknown `f` tag, unknown document keys, tuple arity
outside 2..5, out-of-range intern indexes, source codes outside {0,1,2,3},
wrong field types; VTL: malformed header, extra tab segments on node lines,
malformed heads/tokens, non-object props/data, wrong query/component tuple
shapes, duplicate `D` lines or `C` names, unknown opcodes. The readable arm is
held to the same boundary (its output goes through `canonicalize`), so no arm
gets validity credit another would be denied. Duplicate node ids and the caps
are policed by `validateTree`, which runs on every decode in the measurement.

The property Arbitrary (`src/arbitrary.ts`) spans nested/shared/cyclic/dangling
children, all binding kinds, actions, `fn:` refs, queries at the 16-cap,
components maps, escaping-hostile unicode in prop/data values, AND hostile
ids/component names (interior/leading/trailing spaces, tabs, newlines, leading
`"`/`.`/`:`/`*`, unicode, empty-string child ids) so the VTL token escaping is
property-policed, not just hand-tested. Hand-built edge cases cover
empty-vs-absent, DAG+cycle, dangling ids, the `.Foo` sigil collision, strict-
decoder rejections, extension-field rejection, and trees at/near the 5000-node
cap. A fixed seed keeps the run reproducible in CI (a failure still prints the
reproducing path).

**One documented boundary (a JSON fact, not a profile defect):** a numeric value
of negative zero (`-0`) is not representable in JSON — `JSON.stringify(-0)` is
`"0"`, so `-0` collapses to `+0` on the *readable minified wire itself*, before
any compact profile is involved. Both profiles serialize values as JSON, so they
inherit exactly that behavior. `-0` is therefore out of scope for JSON-based
losslessness and is normalized out of the generator; every value the readable
wire can represent round-trips exactly.

---

## 5. Token savings on real trees (measured)

`src/measure-tokens.ts`, Anthropic count-tokens API (authoritative for Claude),
model `claude-sonnet-5`. Fixtures: three trees harvested from the legacy quarry
(tiny unit-test inputs) + three fresh trees the real model generated for
realistic host-app requests (35–58 nodes). **Baseline = minified JSON** (the
honest wire baseline — a server never sends pretty JSON); pretty JSON is shown
only for reference. A count wraps each string as one user message, adding a small
fixed per-call overhead identical across arms; byte counts (overhead-free) cross-
check the story.

### Tokens — savings vs readable-min

| fixture | nodes | pretty | min | CJT | VTL | CJT % | VTL % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| harvested/dag-shared | 4 | 197 | 119 | 95 | 45 | 20.2% | 62.2% |
| harvested/resolve-nested | 3 | 169 | 108 | 90 | 49 | 16.7% | 54.6% |
| harvested/stage-meshed | 4 | 500 | 380 | 336 | 292 | 11.6% | 23.2% |
| generated/at-risk-clients | 58 | 4890 | 3262 | 2368 | 2190 | 27.4% | 32.9% |
| generated/deadline-timeline | 55 | 4834 | 3249 | 2398 | 2226 | 26.2% | 31.5% |
| generated/document-progress | 35 | 3169 | 2133 | 1582 | 1464 | 25.8% | 31.4% |
| **TOTAL** | | 13759 | 9251 | 6869 | 6266 | **25.7%** | **32.3%** |

### Bytes — savings vs readable-min (overhead-free cross-check)

| fixture | pretty | min | CJT | VTL | CJT % | VTL % |
| --- | --- | --- | --- | --- | --- | --- |
| generated/at-risk-clients | 12401 | 7158 | 4215 | 3942 | 41.1% | 44.9% |
| generated/deadline-timeline | 12225 | 7062 | 4249 | 3982 | 39.8% | 43.6% |
| generated/document-progress | 8179 | 4811 | 3008 | 2809 | 37.5% | 41.6% |
| **TOTAL (all 6)** | 34833 | 20359 | 12409 | 11458 | **39.0%** | **43.7%** |

**Reading:** on the trees that matter (the realistic generated ones), VTL saves
**~31–33%** of output tokens vs minified JSON and CJT **~26–27%**. Three honest
caveats:

1. **~65% does not materialize at the token level.** Byte savings are ~39–44%,
   token savings ~26–33%. The Claude tokenizer already merges the repeated `"`,
   `:`, `,`, and common key/component strings that a byte count charges full
   price for. The Monogram figure is a byte-ish / different-tokenizer number; our
   own tokenizer gives back much of it.
2. **VTL's edge over CJT is modest in tokens (~5–6 points)** even though it is
   larger in bytes — again the tokenizer flattens the difference. The intern
   table + positional tuples (CJT) and the line format (VTL) end up close once
   tokenized.
3. **The honest baseline halves the story.** Most of the pretty→compact drop is
   just pretty→minified. Against minified JSON — what the wire actually is — the
   marginal win of a bespoke profile is the ~26–33% above, not the eye-catching
   pretty-vs-compact numbers.

---

## 6. Live latency + emission validity (measured)

`src/generate-latency.ts` has `claude-sonnet-5` and `claude-haiku-4-5` generate
the same three host-app views three ways — readable `vendo-genui/v1` JSON,
candidate A (CJT), candidate B (VTL) — each with its format spec + one worked
few-shot in the prompt (built from the real encoders, so the example is provably
decodable). Thinking is forced OFF to isolate raw generation latency. Per trial:
output tokens, wall-clock total, TTFB, VALIDITY under the **strict** decoders
(§4), and the decoded tree's COMPLEXITY (nodes / prop keys / components).

Bias controls (review round 2): arm order is **shuffled every trial round**
(never fixed readable→CJT→VTL); **every attempted trial is retained** — raw
per-trial records are committed at [`results/latency.json`](./results/latency.json)
— and token/latency means are reported for ALL trials and VALID-only trials
separately. 2 rounds × 3 requests = **6 samples per arm per model, 12 compact
trials per model** (small — treat as directional; the validity *pattern* and the
complexity means, not the third decimal, are the signal).

### Per-arm aggregate (strict decoders; all-trials vs valid-only)

| model | arm | n | valid | outTok all/valid | totalMs all/valid | mean nodes (valid) | mean propKeys (valid) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sonnet-5 | readable | 6 | **100%** | 2846 / 2846 | 18844 / 18844 | 46 | 64 |
| sonnet-5 | CJT | 6 | **100%** | 1529 / 1529 | 11539 / 11539 | **32** ⚑ | **46** ⚑ |
| sonnet-5 | VTL | 6 | **100%** | 1605 / 1605 | 11553 / 11553 | 40 | 56 |
| haiku-4-5 | readable | 6 | **100%** | 2971 / 2971 | 11784 / 11784 | 42 | 61 |
| haiku-4-5 | CJT | 6 | **50%** | 1221 / 1166 | 6476 / 6520 | 33 | 44 |
| haiku-4-5 | VTL | 6 | **67%** | 1044 / 1384 | 5898 / 7613 | 47 | 73 |

(No request-level errors occurred; every trial completed and is in the data
file. TTFB was statistically indistinguishable across arms and is in the raw
records.)

### What this shows

- **Latency IS roughly linear in output tokens** (the Monogram premise holds).
  The cleanest evidence is a complexity-matched pair: on sonnet,
  `deadline-timeline` readable produced a 55-node tree at 3274 tok / 21.3 s and
  VTL a 54-node tree at 2008 tok / 13.6 s — same-complexity output, **−39%
  tokens, −36% wall-clock**, both valid.
- **⚑ The complexity confound is real, and it bites CJT.** Each arm generates
  its own tree, so an arm can "win" by emitting a simpler tree — and on sonnet
  the CJT arm did exactly that: mean 32 nodes vs readable's 46 (two
  `deadline-timeline` CJT trials collapsed to 15–19 nodes vs readable's 55).
  **CJT's headline −39% latency is therefore partly a simpler-tree artifact,
  not a pure encoding win.** VTL held complexity much closer to readable (40 vs
  46 mean nodes; several trials node-for-node identical) while still cutting
  ~40% of tokens — VTL's number is the honest one. Residual confound stands for
  all arms and is flagged again in §9.
- **Validity is a cliff on the weaker model — and strict decoding sharpened
  it.** On this run haiku emitted *readable* JSON at 6/6 validity, but CJT at
  **50%** and VTL at **67%**. Failures are systematic format errors, not noise:
  labeling prewired names (`Stack`) as `source:"generated"` with no definition,
  and one CJT tuple with out-of-grammar arity that the strict decoder itself
  rejected. The invalid VTL outputs were also *truncated-tiny* (342–384 tok) —
  visible in the all-vs-valid token gap (1044 vs 1384) — i.e. when the weak
  model gets confused by a compact format it doesn't just err, it under-builds.
  **A ~45% token cut the model bungles a third to a half of the time is a
  losing trade.** Emission reliability, not raw speed, is the deciding axis,
  and it is entirely a property of the generating model.
- **Sonnet-5 emits all three formats at 100% validity (12/12 compact trials
  under strict decoding)** — model-emitted compact is genuinely viable on a
  strong model, worth ~35–40% of generation wall-clock.

Caveats: n = 6 per arm per model; readable's 67%→100% haiku swing between this
run and the pre-review run shows exactly how noisy per-run validity rates are at
this sample size — directionally, compact < readable on haiku in both runs, and
that ordering is the finding. The prior (pre-review) run used lenient decoders
and fixed arm order; it is superseded by this table.

---

## 7. Streaming-suitability assessment (design, not built)

The spec also reserves "valid-while-partial streaming semantics." Assessment of
each candidate's prefix behavior (a prefix of the compact form should correspond
to a renderable partial tree):

- **Readable JSON tree** streams poorly as-is: a truncated JSON object is not
  parseable without a tolerant/partial JSON parser, but the flat-node + dangling-
  child design already gives the renderer its streaming story (unknown children =
  skeletons). Any profile inherits that.
- **VTL is streamable under a documented ordering discipline — not
  unconditionally** (claim corrected in review round 2). The GRAMMAR itself does
  not guarantee useful prefixes: nothing in it forbids a writer putting `C`
  lines first or (in a future revision) the header late, and **model-emitted
  VTL carries no ordering guarantee at all**. What is true: the ENCODER emits a
  fixed order — header (root known immediately), then nodes in array order,
  then `D`/`Q`/`C` — and under that discipline a prefix ending at a line
  boundary is a well-formed, smaller node set whose not-yet-seen children
  render as skeletons. Two honest caveats even then: (a) a prefix containing a
  `source:"generated"` node is NOT `validateTree`-valid until its `C` line
  arrives (the validator requires the definition), so a streaming renderer
  must treat undefined generated components as skeletons — a renderer-policy
  extension, not a property the format gives for free; (b) putting `C` lines
  *first* would fix (a) but delays first paint behind up-to-256KB of component
  source, which is worse for the actual streaming goal. Net: VTL is the most
  streaming-friendly of the three **for encoder-produced wires**, and any real
  adoption would need the ordering discipline written into the profile spec.
- **CJT streams badly.** Its intern table `k` must precede the node tuples that
  reference it by index, and the whole thing is one JSON document — a prefix is
  neither valid JSON nor index-resolvable until the table is complete. The intern
  table is the enemy of both streaming and left-to-right emission.

---

## 8. How a winner would integrate later (hypothetical — NOT registered)

Per `docs/contracts/01-core.md` §8, the instant-path payload is a format-tagged
document (`UIPayload.formatVersion`), and v0 registers **exactly one** format —
the tree, `vendo-genui/v1`. A compact profile would slot in behind that tag as a
**new registered format** under a **clearly-hypothetical, NOT-registered** tag,
e.g. `vendo-genui-vtl/1`. It would ride the same dispatch the contract already
describes: validators/renderers/edit-dialects switch on `formatVersion`, an
unregistered tag is a contained failure, and a runtime keeps rendering every
format it ever registered. Because the encoding is a lossless view of the same
tree, `AppDocument`, the wire routes, `fn:` references, and stored records are all
untouched — a runtime would decode-to-tree at the edge and everything downstream
sees the existing `Tree`. **This tag name is illustrative only; this spike
registers nothing.**

The natural seam: the **server/generation engine** emits compact on the wire and
the client decodes to the canonical tree before rendering — a pure transport
optimization, invisible to the renderer. That is a very different thing from
asking the **model** to emit compact (see the recommendation).

---

## 9. Recommendation

**Recommendation: do not adopt a compact profile into v0. Keep VTL (not CJT) as
the reserved profile of record, and if it is ever built, default it to a
deterministic server→client *transport* encoding — never require the model to
emit it.** Details:

1. **Adopt nothing now.** The savings are real but modest — **~26–33% of output
   tokens** on realistic trees against the honest minified-JSON baseline, not the
   ~65% the research suggested (our own tokenizer already eats most of the
   byte-level win). That does not clear the bar for a second permanent registered
   wire format, its encoder/decoder, and a streaming parser to maintain for the
   life of the version train — not while the tree is rarely the latency
   bottleneck and v0 is still being built.

2. **If ever adopted, pick VTL over CJT — the review-round-2 data made this
   clearer, not weaker.** On tokens VTL beats CJT on the deterministic re-encode
   of identical trees (§5: 32.3% vs 25.7%). On model emission, CJT's apparent
   latency edge dissolved once tree complexity was recorded: the CJT arm
   "won" partly by generating simpler trees (mean 32 nodes vs readable's 46),
   while VTL held complexity near-parity and still cut ~40% of tokens — and VTL
   out-scored CJT on strict-decode validity on the weak model (67% vs 50%).
   Add CJT's intern table being a liability for *both* streaming and
   left-to-right emission, and there is no axis left on which CJT wins.

3. **Default any adoption to transport-only.** The safe, universal win is a
   deterministic re-encode: the engine generates the readable tree, re-encodes to
   VTL for the wire, the client decodes back to the canonical `Tree` before
   rendering. It is lossless (within the loud extension-field boundary of §4),
   invisible to the renderer, and carries **zero validity risk** because a
   function — not the model — produces the compact form. It captures the
   wire-size reduction on every model, including weak ones, and it is the only
   mode in which the §7 streaming ordering discipline can actually be
   guaranteed.

4. **Model-emitted compact (the big latency lever) must be capability-gated, not
   default.** The ~35–40% generation-latency cut only exists when the *model*
   emits compact, and that is only safe on a strong model (sonnet-5: 12/12
   compact trials valid under strict decoding; haiku-4-5: 50–67%, with failures
   that under-build the tree, not just malform it). For an OSS **BYO-LLM**
   product where the host plugs in an arbitrary model, defaulting to
   model-emitted compact would silently break generation on weaker models. It
   could ship later only as an opt-in mode gated behind a per-model validity
   check — worth revisiting if/when generation latency becomes a *measured*
   bottleneck and the engine standardizes on a model that emits VTL at ~100%
   validity.

**A negative-leaning result is still a successful spike:** it retires the ~65%
expectation for our tokenizer, proves the encoding is losslessly feasible over
the full contract range (so the option stays open with no format-freeze regret),
names the real deciding constraint (emission reliability under BYO-LLM, not raw
size — plus a same-complexity discipline any future benchmark must keep), and
picks the winner (VTL) for the day the reserved profile is actually built.

**Residual confounds, named:** each arm still generates its own tree, so even
with complexity reported the arms are not literally the same artifact — a fully
controlled design would have the model *transcribe* a fixed tree into each
format, at the cost of no longer measuring realistic generation. n = 6 per arm
per model; validity rates at this n carry ±1-trial noise (haiku readable moved
67%→100% between runs). Raw per-trial records: `results/latency.json`.
