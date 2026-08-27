---
"@vendoai/vendo": minor
---

`connectedAccounts` splits out of `connectors`, so one word no longer names two products.

`connectors` carries connector objects — the outside APIs your deployment brings under one credential **you** hold. `connectedAccounts` names the services each of your **users** connects for themselves:

```ts
createVendo({
  connectedAccounts: ["gmail", "slack"],
  connectors: [mcpConnector({ url, headers })],
});
```

A bare service string in `connectors` used to mean the second product while an object meant the first. It still works and warns once, for one more minor. Naming services in both keys is refused at boot rather than merged, because which key scopes the connect dock would be a guess.
