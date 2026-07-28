---
"@vendoai/actions": patch
---

A failed host call now names the origin it called, not just the path.

`http-error` outcomes were formatted `GET /customers → 404: …`. When a
deployment's `VENDO_BASE_URL` points at the wrong host, every tool 404s while
every path is correct — and that message reads exactly like a malformed path.
It now reads:

```
GET https://api.example.com/customers → 404: no such route
```

The target is assembled from the URL's origin and path only, so a `baseUrl`
carrying userinfo (`https://svc:pw@host`, `https://ghp_x@host`) or a
query-string token never reaches an error message, a host log, or the model.
