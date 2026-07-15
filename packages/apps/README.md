# @vendoai/apps

Owns Vendo app documents, instant tree rendering, app generation, sandbox
adapters, snapshots, and the guarded host-tool proxy used by app machines.

`@vendoai/apps/cloud` reserves the same `SandboxAdapter` seam for Vendo Cloud.
The OSS v0 export is an explicit `cloud-required` stub; the hosted
implementation will provide adapter-level `create`/`resume` and machine-level
`request`/`exec`/`files`/`snapshot`/`url`/`stop` over that frozen interface.

Read [Generated UI](https://docs.vendo.run/concepts/generated-ui).
