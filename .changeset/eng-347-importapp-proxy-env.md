---
"@vendoai/apps": patch
---

Inject the standard run environment when `importApp` provisions a machine (ENG-347, 06-apps §4.2).

Import rebuilt an app-directory machine with `env: { PORT }` only, bypassing the
shared env helper the create/edit path uses. The secrets egress fetch shim then
declined to install (it requires `VENDO_PROXY_URL` + `VENDO_RUN_TOKEN`), so an
imported rung-2/3 app could not reach host tools or the egress endpoint until it
was re-edited. Provisioning now routes through the machine cache, baking the same
§4.2 run environment (`PORT`, `VENDO_PROXY_URL`, a freshly minted `VENDO_RUN_TOKEN`,
and declared secret handles) into the rebuilt snapshot, so an imported app reaches
tools/egress with no subsequent edit.
