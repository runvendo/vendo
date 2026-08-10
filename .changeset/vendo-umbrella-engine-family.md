---
"@vendoai/vendo": patch
---

The umbrella's own drawers go through the `engine` family instead of the generic
record façade.

Generic `records.*` is a host's door onto its own data. Vendo was reaching for
its own collections through it — the parked BYO approvals, the app and grant
drawers the impact report reads, the app row machine provisioning resolves an
owner from, and the two `vendo sync` pushes to Cloud. Nothing in that call said
which collections were Vendo's, so nothing could refuse a call that reached for
one. Each of these now names its collection through `ops.engine.*`, which is the
same seven verbs onto the same routed doors with `assertEngineCollection` in
front — per-collection policy is unchanged, because `engine` reaches the very
same door `records` did.

The one behavior change is a refusal that used to be silence. A deployment whose
store offers neither its own `ops` nor a SQL handle previously ran these paths
through the façade; it now gets a `not-implemented` naming the two stores that
serve them (`store: postgres(url)` or the Cloud hosted store). Three seams do
this — parking a BYO guarded call, the `/sync/impact` report, and machine-app
provisioning. The fourth, the `?pending=1` app probe, keeps its existing
behavior of degrading to the pending window rather than throwing, because that
is what it already did for any store that could not answer.

`vendo_threads` stays on the record façade deliberately, as `mcp` and
`knowledge` do: its double mirrors the routed door's projection and
cross-subject refusal, and reaching it through a second door would have traded
real coverage for a rename.
