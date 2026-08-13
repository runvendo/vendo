---
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

next-auth v4 hosts fail loud and correct instead of silently breaking: the
authJs preset resolves `AUTH_SECRET` then v4's `NEXTAUTH_SECRET` (Auth.js's
own legacy order), defers module/secret work until an Auth.js session cookie
is actually present (a misconfigured preset no longer 501s anonymous
traffic), and names next-auth v4 once when it sees a v4 session cookie.
`vendo init` prints a v4 advisory when wiring authJs onto a major-4 host.
The wire surfaces a failed principal resolver's own message instead of a
generic Internal Vendo error. Doctor distinguishes a declined actAs mint
(new E-AUTH-008 warning) from an unconfigured seam (E-AUTH-007), passes the
wire's failure reason through E-AUTH-004, and its act-as pass message stops
claiming host verification the probe never performs.
