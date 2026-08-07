---
"@vendoai/actions": minor
---

GraphQL extraction is gone. The advertised extraction tier is four stacks: OpenAPI, route-scan, tRPC, Next.js server actions.

The GraphQL extractor was ~2.2k lines — SDL parsing, `@nestjs/graphql` and
`type-graphql` code-first resolver walking, endpoint discovery, document
generation — and its only real-world corpus host emitted *every* operation
`disabled` by design, because static analysis cannot attribute an operation to
one of several schema endpoints. A stack we could detect but never usefully
extract is worse than one we never mention, so the detection went with it.

Removed with it: the `graphql` binding kind in `vendo/tools@3` (`GraphqlBinding`,
`graphqlBindingSchema`), its slot in the tool-identity rule, and the GraphQL HTTP
transport in the runtime registry. This is breaking for a host whose committed
`.vendo/tools.json` already carries a `graphql` binding — that file no longer
parses. Pre-1.0, no deprecation shim ships; re-run `vendo sync` to regenerate.

Route-scan skips a GraphQL endpoint instead of falling back to it. A Next.js
GraphQL handler exports `POST` like any other route, so generic scanning would
mint an enabled tool that posts the model's arguments as the JSON body — which
every GraphQL server rejects, since it wants a `{ query, variables }` envelope.
The endpoint now yields no tool and a warning naming it. Cut means gone, not
gone-and-quietly-worse. Detection reads every module the verb scan already
resolves — the route file plus the local re-exports it follows — so a handler
kept in a separate file is skipped too. A route that merely *imports* a GraphQL
server and wraps it in its own exported handler is still scanned generically;
disable that tool through `overrides.json`.

Behaviour for the four surviving stacks is unchanged.
