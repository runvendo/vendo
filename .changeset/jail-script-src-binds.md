---
"@vendoai/ui": patch
---

The jail's `script-src` actually binds, so a sandboxed component cannot phone
home.

The generated-component jail carried `script-src 'nonce-<N>' 'unsafe-eval'`, and
the nonce was the hole. CSP blanks a nonce's content attribute but not its IDL
property, so code running inside the jail — which is the untrusted code — could
read the jail's own nonce off a script element and stamp it on a `<script src>`
of its own. Browser-verified against the shipped policy: the request completed,
foreign code executed in the jail, and the data in its URL left the browser. A
nonce in `script-src` also makes `'unsafe-inline'` be ignored, so the directive's
source list — deliberately empty — never governed anything.

The policy is now `script-src 'unsafe-inline' 'unsafe-eval'`. Nothing about the
jail is relaxed: `'unsafe-inline'` only permits inline script, which this
document is entirely made of and which `'unsafe-eval'` already allowed the realm
to produce, and with no nonce present the empty source list is finally the thing
that decides. A component can no longer load a script from any origin, so the
residual exfiltration risk — a shared or remixed component sending the data it
was handed somewhere — is closed. `default-src 'none'`, `connect-src 'none'`,
the opaque origin, and the `allow-scripts`-only sandbox are unchanged.

Hosts are unaffected: an `about:srcdoc` frame also inherits the embedder's
policy, and the jail boots (or does not) under exactly the same host policies as
before.
