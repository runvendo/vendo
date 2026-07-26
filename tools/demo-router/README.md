# demo-router

The always-on service behind `demos.vendo.run`. Holds the demo registry
(id → Railway URL, expiry, kill switch, hit counter) and 302-redirects
`GET /:id` to the demo's own Railway domain. Expired, killed, or unknown ids
get a small branded "book a call" page instead of a broken link.

Zero dependencies, plain `node:http`. Deliberately **outside** the pnpm
workspace so it deploys standalone (Railway builds just this directory).

## Environment

| Variable             | Default               | Purpose                                                    |
| -------------------- | --------------------- | ---------------------------------------------------------- |
| `PORT`               | `8080`                | Listen port.                                               |
| `REGISTRY_PATH`      | `/data/registry.json` | Registry file — point it at a Railway volume mount.        |
| `ROUTER_ADMIN_TOKEN` | (unset)               | Bearer token for `/admin/demos`. Unset ⇒ admin API is 503. |

The registry is one atomic JSON file (temp write + rename). A corrupt file
fails **closed**: every id routes as unknown, admin calls 500, and the file is
never overwritten — inspect or delete it to recover. Mount a volume at `/data`
or rows vanish on redeploy.

## Public routes

- `GET /healthz` → `{ok, demos}`
- `GET /` → 302 `https://vendo.run`
- `GET /:id` → live: 302 to the demo (counts a hit); expired/killed: 410 page;
  unknown: 404 page. Ids are never listed publicly.

## Admin API

All under `/admin/demos`, JSON in/out, `Authorization: Bearer $ROUTER_ADMIN_TOKEN`.

```sh
# List
curl -H "Authorization: Bearer $ROUTER_ADMIN_TOKEN" https://demos.vendo.run/admin/demos

# Add / replace a demo
curl -X POST -H "Authorization: Bearer $ROUTER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"acme","url":"https://demo-acme.up.railway.app","prospect":"Acme Widgets","expiresAt":"2026-08-01T00:00:00Z"}' \
  https://demos.vendo.run/admin/demos

# Kill switch / extend expiry / repoint
curl -X PATCH -H "Authorization: Bearer $ROUTER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"killed":true}' https://demos.vendo.run/admin/demos/acme

# Remove the row (demo:reap does this after tearing down the Railway service)
curl -X DELETE -H "Authorization: Bearer $ROUTER_ADMIN_TOKEN" https://demos.vendo.run/admin/demos/acme
```

## Develop

```sh
node --test          # from this directory (or: node --test "tools/demo-router/*.test.mjs" from the repo root)
PORT=8080 REGISTRY_PATH=/tmp/registry.json ROUTER_ADMIN_TOKEN=dev node server.mjs
```
